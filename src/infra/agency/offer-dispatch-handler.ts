/**
 * P299-D: Liaison-side offer_dispatch handler.
 *
 * Receives an `offer_dispatch` message from the orchestrator (sent via the
 * liaison message bus), forks the CLI subprocess via `spawnAgent`, renews the
 * lease while the subprocess runs, and on exit calls `fn_complete_work_offer`
 * directly.
 *
 * Design rule: **the orchestrator is a mechanical process and does not
 * interpret AI-generated content**. So this handler does NOT send a
 * `claim_status` uplink with stdout summary or any LLM text back to the
 * orchestrator. The lifecycle is communicated purely via mechanical SQL state
 * changes:
 *   - lease renewal     → `fn_renew_lease` (succeeds while spawn runs)
 *   - offer completion  → `fn_complete_work_offer(claim_token, status)`
 *   - liaison crash     → lease TTL expires; orchestrator's offer reaper
 *                         requeues mechanically (no message exchanged)
 *
 * `agentLabel` is intentionally omitted from the spawnAgent call so that
 * agent-spawner's structured-identity branch (P852) builds the
 * `{rt}-{host}-{exp}-{n}` name from the resolved route + capabilities.
 */
import { query } from "../postgres/pool.ts";
import { spawnAgent, spawnWithRetry } from "../../core/orchestration/agent-spawner.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import {
	checkCapacityBeforeClaim,
	declareAgencyThrottled,
	recordUsage,
} from "./subscription-quota.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface OfferDispatchHandlerDeps {
	/** Override for test injection. */
	spawn?: typeof spawnAgent;
	/** Override for test injection of fn_renew_lease + fn_complete_work_offer. */
	exec?: SqlExec;
	logger?: Pick<Console, "log" | "warn" | "error">;
	/**
	 * Resolves the worktree directory for an agency dispatch. Most agencies
	 * have a 1:1 agency↔worktree mapping; the default reads from
	 * `AGENCY_WORKTREE` env (set by `agenthive-liaison@<agency>.service`).
	 */
	resolveWorktree?: (agencyId: string) => string;
	/** Renewal cadence override (ms). Default: leaseTtlSeconds * 1000 / 3. */
	renewalIntervalMs?: number;
	/** Override for test injection of local quota/capacity checks. */
	checkCapacity?: typeof checkCapacityBeforeClaim;
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
	lease_ttl_seconds?: number;
	/** P914: worktree directory basename selected by the orchestrator. */
	worktree_hint?: string | null;
}

const DEFAULT_LEASE_TTL_SECONDS = 60;

const defaultExec: SqlExec = (sql, params) =>
	query(sql, params as unknown[]);

const defaultDeps: Required<
	Pick<
		OfferDispatchHandlerDeps,
		"spawn" | "exec" | "logger" | "resolveWorktree"
	>
> = {
	spawn: spawnWithRetry,
	exec: defaultExec,
	logger: console,
	// P914: include AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE (the var actually
	// set in /etc/agenthive/env, e.g. "codex-one") as a fallback so the
	// spawn cwd resolves to a real directory under WORKTREE_ROOT instead
	// of the literal "main" which never existed.
	resolveWorktree: (_agencyId) =>
		process.env.AGENCY_WORKTREE ??
		process.env.AGENTHIVE_DEFAULT_WORKTREE ??
		process.env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE ??
		"codex-one",
};

/**
 * Handle an `offer_dispatch` message addressed to `agencyId`.
 *
 * Spawns the CLI subprocess asynchronously (the message handler returns as
 * soon as the spawn is initiated). Renews the lease via fn_renew_lease while
 * the subprocess runs; on exit calls fn_complete_work_offer with delivered
 * (exit 0) or failed (non-zero or thrown) status. No message is sent back to
 * the orchestrator — the orchestrator is mechanical and observes lifecycle
 * via DB state alone.
 */
export async function handleOfferDispatch(
	agencyId: string,
	msg: LiaisonMessage,
	deps: OfferDispatchHandlerDeps = {},
): Promise<void> {
	const spawn = deps.spawn ?? defaultDeps.spawn;
	const exec = deps.exec ?? defaultDeps.exec;
	const logger = deps.logger ?? defaultDeps.logger;
	const resolveWorktree = deps.resolveWorktree ?? defaultDeps.resolveWorktree;

	const payload = msg.payload as unknown as OfferDispatchEnvelope;
	if (!payload?.offer_id || !payload.role) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: malformed payload, missing offer_id/role`,
		);
		return;
	}
	if (!payload.dispatch_id || !payload.claim_token) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: payload missing dispatch_id or claim_token; cannot renew/complete the lease — refusing to spawn`,
		);
		return;
	}

	// P914: prefer the orchestrator-selected worktree from the payload;
	// fall back to the agency's local resolver only when the dispatcher
	// didn't supply one (older clients, test fixtures).
	const worktree =
		(payload.worktree_hint && payload.worktree_hint.trim().length > 0
			? payload.worktree_hint
			: undefined) ?? resolveWorktree(agencyId);
	const proposalId = payload.proposal_id ?? undefined;
	const capabilities =
		payload.required_capabilities && payload.required_capabilities.length > 0
			? payload.required_capabilities
			: [payload.role];
	const leaseTtlSeconds = payload.lease_ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS;
	const renewalIntervalMs =
		deps.renewalIntervalMs ??
		Math.max(5_000, Math.floor((leaseTtlSeconds * 1_000) / 3));

	logger.log(
		`[OfferDispatchHandler] ${agencyId}: spawning for offer=${payload.offer_id} role=${payload.role} (route_hint=${payload.route_hint})`,
	);

	void runSpawn({
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		leaseTtlSeconds,
		renewalIntervalMs,
		spawn,
		exec,
		logger,
		checkCapacity: deps.checkCapacity ?? checkCapacityBeforeClaim,
	}).catch((err) => {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: unhandled error for offer=${payload.offer_id}:`,
			err instanceof Error ? err.message : err,
		);
	});
}

async function runSpawn(args: {
	agencyId: string;
	payload: OfferDispatchEnvelope;
	worktree: string;
	proposalId: number | undefined;
	capabilities: string[];
	leaseTtlSeconds: number;
	renewalIntervalMs: number;
	spawn: typeof spawnAgent;
	exec: SqlExec;
	logger: Pick<Console, "log" | "warn" | "error">;
	checkCapacity: typeof checkCapacityBeforeClaim;
}): Promise<void> {
	const {
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		leaseTtlSeconds,
		renewalIntervalMs,
		spawn,
		exec,
		logger,
		checkCapacity,
	} = args;

	const dispatchId = payload.dispatch_id as number;
	const claimToken = payload.claim_token as string;

	// P465: capacity check before spawning — re-queue and throttle if quota exceeded
	// P1379: wrap in try/catch to prevent unhandled errors from escaping
	let capacityCheck;
	try {
		capacityCheck = await checkCapacity(agencyId);
	} catch (capCheckErr) {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: capacity check threw for offer=${payload.offer_id}:`,
			capCheckErr instanceof Error ? capCheckErr.message : capCheckErr,
		);
		try {
			await exec(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
				[dispatchId, agencyId, claimToken, "failed"],
			);
		} catch (completeErr) {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer (capacity-check-error) failed for offer=${payload.offer_id}:`,
				completeErr instanceof Error ? completeErr.message : completeErr,
			);
		}
		return;
	}

	if (!capacityCheck.allowed) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: capacity refused for offer=${payload.offer_id} — ${capacityCheck.refuse_reason}`,
		);
		if (capacityCheck.throttle_until) {
			await declareAgencyThrottled(
				agencyId,
				capacityCheck.throttle_until,
				capacityCheck.refuse_reason ?? "quota_exceeded",
			);
		}
		try {
			await exec(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
				[dispatchId, agencyId, claimToken, "failed"],
			);
		} catch (requeueErr) {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer (capacity-refused) failed for offer=${payload.offer_id}:`,
				requeueErr instanceof Error ? requeueErr.message : requeueErr,
			);
		}
		return;
	}

	const renewalTimer = setInterval(() => {
		void exec(
			`SELECT roadmap_workforce.fn_renew_lease($1, $2, $3, $4)`,
			[dispatchId, agencyId, claimToken, leaseTtlSeconds],
		).catch((err) => {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: fn_renew_lease failed for offer ${payload.offer_id}:`,
				err instanceof Error ? err.message : err,
			);
		});
	}, renewalIntervalMs);

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
		// P914: surface the spawn failure cause so operators can diagnose
		// without grepping; previously the only signal was "exit=n/a".
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: spawn threw for offer=${payload.offer_id} (role=${payload.role}, worktree=${worktree}, route_hint=${payload.route_hint}):`,
			spawnError.message,
		);
	}

	clearInterval(renewalTimer);

	// P465: record usage against local meter (best-effort, 50k token estimate per claim)
	try {
		await recordUsage(agencyId, 50_000, 1);
	} catch {
		/* best-effort */
	}

	const status: "delivered" | "failed" =
		spawnError === null && (result?.exitCode === 0 || result?.exitCode === null)
			? "delivered"
			: "failed";

	// P1393: if the agent_run for this dispatch came back rate_limited (route
	// outage, not a real failure), stamp metadata.failure_reason='rate_limited'
	// before fn_complete_work_offer collapses the row to dispatch_status='failed'.
	// post-work-offer.ts's loop counter excludes rows with this marker so the
	// circuit breaker doesn't fire on quota exhaustion. Best-effort — failure
	// here must not block fn_complete_work_offer (lease cleanup is critical).
	if (status === "failed") {
		try {
			await exec(
				`UPDATE roadmap_workforce.squad_dispatch sd
				    SET metadata = sd.metadata || jsonb_build_object('failure_reason', 'rate_limited')
				  WHERE sd.id = $1
				    AND EXISTS (
				      SELECT 1 FROM roadmap_workforce.agent_runs ar
				       WHERE ar.proposal_id = sd.proposal_id
				         AND ar.agent_identity = $2
				         AND ar.status = 'rate_limited'
				         AND ar.started_at >= COALESCE(sd.claimed_at, sd.assigned_at)
				    )`,
				[dispatchId, agencyId],
			);
		} catch (stampErr) {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: rate_limited marker stamp failed for offer ${payload.offer_id} (non-fatal):`,
				stampErr instanceof Error ? stampErr.message : stampErr,
			);
		}
	}

	try {
		await exec(
			`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
			[dispatchId, agencyId, claimToken, status],
		);
		logger.log(
			`[OfferDispatchHandler] ${agencyId}: offer=${payload.offer_id} ${status} (exit=${result?.exitCode ?? "n/a"})`,
		);
	} catch (completionErr) {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed for offer ${payload.offer_id} — lease will time out and reaper will requeue:`,
			completionErr instanceof Error ? completionErr.message : completionErr,
		);
	}
}
