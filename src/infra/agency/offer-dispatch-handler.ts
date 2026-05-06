/**
 * P299-D: Liaison-side offer_dispatch handler.
 *
 * Receives an `offer_dispatch` message from the orchestrator (sent via the
 * liaison message bus), forks the CLI subprocess via `spawnAgent`, and reports
 * the outcome back to the orchestrator via a `claim_status` uplink.
 *
 * The orchestrator owns the offer lifecycle (renewal + completion). This
 * handler does NOT call `fn_complete_work_offer`; on subprocess exit it sends
 * a `claim_status` uplink and the orchestrator side completes the offer.
 *
 * `agentLabel` is intentionally omitted from the spawnAgent call so that
 * agent-spawner's structured-identity branch (P852) builds the
 * `{rt}-{host}-{exp}-{n}` name from the resolved route + capabilities.
 */
import { spawnAgent } from "../../core/orchestration/agent-spawner.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import { sendMessage } from "./liaison-message-service.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";

export interface OfferDispatchHandlerDeps {
	/** Override for test injection. */
	spawn?: typeof spawnAgent;
	/** Override for test injection. */
	send?: typeof sendMessage;
	logger?: Pick<Console, "log" | "warn" | "error">;
	/**
	 * Resolves the worktree directory for an agency dispatch. Most agencies
	 * have a 1:1 agency↔worktree mapping; the default reads from
	 * `AGENCY_WORKTREE` env (set by `agenthive-liaison@<agency>.service`).
	 */
	resolveWorktree?: (agencyId: string) => string;
}

interface OfferDispatchEnvelope {
	offer_id: string;
	role: string;
	required_capabilities: string[];
	route_hint: string;
	briefing_id?: string;
	claim_token?: string;
	dispatch_id?: number;
	proposal_id?: number;
	squad_name?: string;
}

const defaultDeps: Required<
	Pick<OfferDispatchHandlerDeps, "spawn" | "send" | "logger" | "resolveWorktree">
> = {
	spawn: spawnAgent,
	send: sendMessage,
	logger: console,
	resolveWorktree: (_agencyId) =>
		process.env.AGENCY_WORKTREE ?? process.env.AGENTHIVE_DEFAULT_WORKTREE ?? "main",
};

/**
 * Handle an `offer_dispatch` message addressed to `agencyId`.
 *
 * Spawns the CLI subprocess (asynchronously — the message handler returns as
 * soon as the spawn is initiated), and arranges for a `claim_status` uplink
 * to be sent on subprocess exit.
 */
export async function handleOfferDispatch(
	agencyId: string,
	msg: LiaisonMessage,
	deps: OfferDispatchHandlerDeps = {},
): Promise<void> {
	const spawn = deps.spawn ?? defaultDeps.spawn;
	const send = deps.send ?? defaultDeps.send;
	const logger = deps.logger ?? defaultDeps.logger;
	const resolveWorktree = deps.resolveWorktree ?? defaultDeps.resolveWorktree;

	const payload = msg.payload as unknown as OfferDispatchEnvelope;
	if (!payload?.offer_id || !payload.role) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: malformed payload, missing offer_id/role`,
		);
		return;
	}

	const worktree = resolveWorktree(agencyId);
	const proposalId = payload.proposal_id ?? undefined;
	const capabilities =
		payload.required_capabilities && payload.required_capabilities.length > 0
			? payload.required_capabilities
			: [payload.role];

	logger.log(
		`[OfferDispatchHandler] ${agencyId}: spawning for offer=${payload.offer_id} role=${payload.role} (route_hint=${payload.route_hint})`,
	);

	// Fire the spawn asynchronously; the dispatchMessage() caller returns once
	// the work has been kicked off. The orchestrator's renewal timer keeps the
	// lease alive while the subprocess runs.
	void runSpawnAndReport({
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		correlationId: msg.correlation_id,
		spawn,
		send,
		logger,
	}).catch((err) => {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: unhandled error for offer=${payload.offer_id}:`,
			err instanceof Error ? err.message : err,
		);
	});
}

async function runSpawnAndReport(args: {
	agencyId: string;
	payload: OfferDispatchEnvelope;
	worktree: string;
	proposalId: number | undefined;
	capabilities: string[];
	correlationId: string;
	spawn: typeof spawnAgent;
	send: typeof sendMessage;
	logger: Pick<Console, "log" | "warn" | "error">;
}): Promise<void> {
	const {
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		correlationId,
		spawn,
		send,
		logger,
	} = args;

	let result: SpawnResult | null = null;
	let spawnError: Error | null = null;

	try {
		result = await spawn({
			worktree,
			task: `Execute offer ${payload.offer_id} (role: ${payload.role})`,
			proposalId,
			stage: payload.role,
			capabilities,
			provider: payload.route_hint as never,
			briefingId: payload.briefing_id,
			// agentLabel intentionally omitted — agent-spawner derives the
			// structured identity (P852) when this is undefined.
		});
	} catch (err) {
		spawnError = err instanceof Error ? err : new Error(String(err));
	}

	const status: "delivered" | "failed" =
		spawnError === null && (result?.exitCode === 0 || result?.exitCode === null)
			? "delivered"
			: "failed";

	const summary =
		spawnError !== null
			? spawnError.message.slice(0, 500)
			: (result?.stdout ?? "").slice(-500);

	try {
		await send({
			agency_id: agencyId,
			direction: "liaison->orchestrator",
			kind: "claim_status",
			correlation_id: correlationId,
			payload: {
				offer_id: payload.offer_id,
				status,
				exit_code: result?.exitCode ?? null,
				summary,
			},
		});
		logger.log(
			`[OfferDispatchHandler] ${agencyId}: offer=${payload.offer_id} ${status} (exit=${result?.exitCode ?? "n/a"})`,
		);
	} catch (uplinkErr) {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: failed to send claim_status uplink for offer ${payload.offer_id}:`,
			uplinkErr instanceof Error ? uplinkErr.message : uplinkErr,
		);
	}
}
