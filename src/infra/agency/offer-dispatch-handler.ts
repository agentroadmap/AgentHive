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
import { spawnAgent } from "../../core/orchestration/agent-spawner.ts";
import { resolveExecutorWorktreeFallback } from "../../core/orchestration/executor-worktree-fallback.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import { resolvePersonaByRoleName } from "../../core/orchestration/gate-role-resolver.ts";
// P1140 sibling: `sendMessage` is the default for sendUplink (line ~257);
// referenced as a bare identifier without an import, causing
// ReferenceError on every offer_dispatch handler invocation. Surfaced
// once commit a30efd37 unblocked the LiaisonHub consumption path.
import { sendMessage } from "./liaison-message-service.ts";
import {
	classifyProviderSignal,
	setProviderCooldown,
	recordProviderSuccess,
	type ProviderSignal,
} from "../../core/orchestration/provider-cooldown.ts";
import { ObservabilityWriter } from "../../core/observability/observability-writer.ts";
import {
	evaluateSubscriptionPolicy,
	declareThrottle,
	recordProviderHardLimit,
} from "./subscription-policy.ts";
import { recordSpawnUsage } from "./record-spawn-usage.ts";
import { classifyExit } from "../../core/orchestration/agent-spawner.ts";
import { incrementSpawnFailure, THROTTLE_THRESHOLD } from "../../core/orchestration/resolvers/agency-resolver.ts";
import { validateProposal } from "../../core/orchestration/d4-validator.ts";
import { verifyDeliverables } from "../../core/orchestration/deliverable-verifier.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import { isProviderHealthyForDispatch } from "../../core/provider-health/routing-gate.ts";

const obs = new ObservabilityWriter("agency:offer-dispatch-handler");

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
	/**
	 * AC-5 / test injection: override the uplink send function used to emit
	 * spawn_failure messages. Defaults to sendMessage from liaison-message-service.
	 */
	sendUplink?: typeof sendMessage;
	/**
	 * Hard wall-clock limit passed to spawnAgent for the CLI subprocess.
	 * Default: SPAWN_TIMEOUT_MS env var, or 1_800_000ms (30 min).
	 * The lease is renewed on a separate interval so the DB lease never expires
	 * while spawn runs; this timeout is only a safety guard against hung processes.
	 */
	spawnTimeoutMs?: number;
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
	/** P2335: id of the cubic (project-scoped worktree) leased for this dispatch. */
	cubic_id?: string | null;
	/** P2335: absolute worktree path of the leased cubic; preferred over worktree_hint. */
	cubic_worktree_path?: string | null;
	/** P2335: project the cubic was acquired for. */
	project_id?: number | null;
	/** P908-D: trace correlation UUID threaded from postWorkOffer. */
	trace_id?: string | null;
	/** P1113: pre-resolved behavioral persona text (prepended to task). */
	persona?: string;
	/**
	 * P1438 AC-9: persona NAME chosen by the liaison brain's matchmaker
	 * (matchPersonaForCapability). Distinct from `persona` (the body text): this
	 * is the stable/dynamic label surfaced in the control feed + persisted as
	 * metadata.persona_used telemetry. When present it wins over the role-name
	 * fallback for telemetry attribution.
	 */
	persona_name?: string;
	/** P1113: full task string forwarded from squad_dispatch.metadata.task. */
	task?: string;
}

const DEFAULT_LEASE_TTL_SECONDS = 60;

/**
 * Per-agency concurrent-spawn counter (module-level Map, keyed by agency_id).
 *
 * Post-P1132 (A2A host consolidation), all attached agencies share ONE Node
 * process. Pre-P1132 this was a per-process singleton because each agency had
 * its own systemd unit; the same singleton in the shared process meant 5 spawns
 * total across ALL agencies tripped every agency's cap (5/4) — observed
 * 2026-05-19 as "at capacity" spam returning every offer.
 *
 * Fix (Bug 7): per-agency Map. Each agency tracks its own in-flight count
 * against its own provider_registry.max_in_flight.
 *
 * Semantics (per operator policy 2026-05-14):
 *   "Claim is calculated intention; if there is an obstacle, an agency can
 *    regret and return the offer."
 *
 * When count >= max_in_flight at the moment a dispatch arrives, the handler
 * calls fn_return_work_offer (NOT fn_complete_work_offer with 'failed').
 * fn_return_work_offer reverts offer_status from 'claimed' to 'open', does
 * not increment reissue_count, and emits work_offers notify so any other
 * idle agency picks it up immediately.
 */
const activeSpawnCounts = new Map<string, number>();
function getActiveCount(agencyId: string): number {
	return activeSpawnCounts.get(agencyId) ?? 0;
}
function incActiveCount(agencyId: string): void {
	activeSpawnCounts.set(agencyId, getActiveCount(agencyId) + 1);
}
function decActiveCount(agencyId: string): void {
	activeSpawnCounts.set(agencyId, Math.max(0, getActiveCount(agencyId) - 1));
}

/** @internal — reset for tests that share module state. */
export function _resetActiveSpawnForTest(): void {
	activeSpawnCounts.clear();
}

/** @internal — peek for tests. Pass agencyId to get per-agency count, omit for global sum. */
export function _activeSpawnCountForTest(agencyId?: string): number {
	if (agencyId) return getActiveCount(agencyId);
	let sum = 0;
	for (const n of activeSpawnCounts.values()) sum += n;
	return sum;
}

/**
 * P1360 AC-4/11: Classify spawn error messages to structured error classes.
 * Maps error text patterns to classes used by incrementSpawnFailure for status_reason.
 *
 * @param err — The caught spawn error
 * @returns One of 'auth' | 'spawn' | 'timeout' | 'unknown'
 */
function classifySpawnErrorClass(
	err: Error,
): "auth" | "spawn" | "timeout" | "unknown" {
	const msg = err.message.toLowerCase();
	if (
		msg.includes("auth") ||
		msg.includes("permission") ||
		msg.includes("unauthorized") ||
		msg.includes("forbidden")
	) {
		return "auth";
	}
	if (
		msg.includes("timeout") ||
		msg.includes("killed") ||
		msg.includes("sigterm")
	) {
		return "timeout";
	}
	if (
		msg.includes("spawn") ||
		msg.includes("enoent") ||
		msg.includes("eacces")
	) {
		return "spawn";
	}
	return "unknown";
}

const defaultExec: SqlExec = (sql, params) =>
	query(sql, params as unknown[]);

async function hasSquadDispatchProviderSignalColumn(
	exec: SqlExec,
): Promise<boolean> {
	const result = await exec(
		`SELECT 1
		   FROM information_schema.columns
		  WHERE table_schema = 'roadmap_workforce'
		    AND table_name = 'squad_dispatch'
		    AND column_name = 'provider_signal'
		  LIMIT 1`,
	);
	return ((result as any)?.rows?.length ?? 0) > 0;
}

const defaultDeps: Required<
	Pick<
		OfferDispatchHandlerDeps,
		"spawn" | "exec" | "logger" | "resolveWorktree"
	>
> = {
	spawn: spawnAgent,
	exec: defaultExec,
	logger: console,
	// P1445 AC-3: the orchestrator now allocates a worktree atomically and
	// passes it as worktree_hint. The ad-hoc AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE
	// env fallback is gated behind resolveExecutorWorktreeFallback() (opt-in via
	// AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK=1) so two dispatches can no longer
	// silently self-select the SAME shared checkout from the environment.
	resolveWorktree: (_agencyId) =>
		process.env.AGENCY_WORKTREE ??
		process.env.AGENTHIVE_DEFAULT_WORKTREE ??
		resolveExecutorWorktreeFallback() ??
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

	// Capacity gate: if this agency is at or above its max_in_flight threshold
	// (configured per-agency in provider_registry), return the offer instead
	// of accepting it. fn_return_work_offer flips offer_status back to 'open',
	// rotates the claim token, and pg_notify's the claim loop so an idle
	// agency picks it up. No reissue penalty, no failure metric pollution.
	const maxInFlight = await readAgencyMaxInFlight(agencyId, exec, logger);
	const currentCount = getActiveCount(agencyId);
	if (currentCount >= maxInFlight) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: at capacity (${currentCount}/${maxInFlight}); returning offer=${payload.offer_id} role=${payload.role}`,
		);
		await exec(
			`SELECT roadmap_workforce.fn_return_work_offer($1, $2, $3, $4)`,
			[
				payload.dispatch_id,
				agencyId,
				payload.claim_token,
				`agency_at_capacity:${currentCount}/${maxInFlight}`,
			],
		).catch((err) => {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_return_work_offer failed on capacity-decline:`,
				err instanceof Error ? err.message : err,
			);
		});
		return;
	}

	// Usage-limit pause: if this agency has been paused after a prior usage-
	// limit hit, decline to spawn so the orchestrator's reissue logic routes
	// the offer to an unpaused agency. We still must call fn_complete_work_offer
	// so the orchestrator can see the offer is done and create a new dispatch.
	const pausedUntil = await readAgencyPausedUntil(agencyId, exec, logger);
	if (pausedUntil && pausedUntil.getTime() > Date.now()) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: paused until ${pausedUntil.toISOString()} (usage-limit); declining offer=${payload.offer_id} role=${payload.role}`,
		);
		await exec(
			`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
			[payload.dispatch_id, agencyId, payload.claim_token, "failed"],
		).catch((err) => {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed on paused-decline:`,
				err instanceof Error ? err.message : err,
			);
		});
		return;
	}

	// P465: subscription-aware claim policy — refuse new claims that would breach
	// the safety margin. Return the offer (no failure penalty) so another agency
	// can pick it up, then self-declare throttled until the tightest window resets.
	const policyResult = await evaluateSubscriptionPolicy(agencyId, exec, logger);
	if (!policyResult.allowed) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: subscription policy refused offer=${payload.offer_id}: ${policyResult.reason}`,
		);
		await exec(
			`SELECT roadmap_workforce.fn_return_work_offer($1, $2, $3, $4)`,
			[
				payload.dispatch_id,
				agencyId,
				payload.claim_token,
				`subscription_quota_refused:${policyResult.reason}`,
			],
		).catch((err) => {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_return_work_offer failed on subscription-refuse:`,
				err instanceof Error ? err.message : err,
			);
		});
		await declareThrottle(
			agencyId,
			policyResult.resets_at,
			policyResult.reason ?? "subscription_quota_exceeded",
			exec,
		).catch((err) => {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: declareThrottle failed:`,
				err instanceof Error ? err.message : err,
			);
		});
		return;
	}

	// P2335 AC-9: prefer the leased cubic's worktree path; then the legacy
	// orchestrator-selected worktree_hint (P914); finally fall back to the
	// agency's local resolver only when neither was supplied (older clients,
	// test fixtures). cubic_worktree_path is an absolute path; worktree_hint
	// is a basename — both are accepted downstream.
	const worktree =
		(payload.cubic_worktree_path && payload.cubic_worktree_path.trim().length > 0
			? payload.cubic_worktree_path
			: undefined) ??
		(payload.worktree_hint && payload.worktree_hint.trim().length > 0
			? payload.worktree_hint
			: undefined) ??
		resolveWorktree(agencyId);
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

	const spawnTimeoutMs =
		deps.spawnTimeoutMs ??
		parseInt(process.env.SPAWN_TIMEOUT_MS ?? "1800000", 10);

	const spawnPromise = runSpawn({
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		leaseTtlSeconds,
		renewalIntervalMs,
		spawnTimeoutMs,
		spawn,
		exec,
		logger,
		sendUplink: deps.sendUplink ?? sendMessage,
	}).catch((err) => {
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: unhandled error for offer=${payload.offer_id}:`,
			err instanceof Error ? err.message : err,
		);
	});

	// Reserve a capacity slot. The `finally` decrements whether the spawn
	// succeeds, fails, throws, or times out — so the counter never gets stuck
	// above zero if runSpawn misbehaves.
	incActiveCount(agencyId);
	spawnPromise.finally(() => {
		decActiveCount(agencyId);
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
	spawnTimeoutMs: number;
	spawn: typeof spawnAgent;
	exec: SqlExec;
	logger: Pick<Console, "log" | "warn" | "error">;
	sendUplink: typeof sendMessage;
}): Promise<void> {
	const {
		agencyId,
		payload,
		worktree,
		proposalId,
		capabilities,
		leaseTtlSeconds,
		renewalIntervalMs,
		spawnTimeoutMs,
		spawn,
		exec,
		logger,
		sendUplink,
	} = args;

	const dispatchId = payload.dispatch_id as number;
	const claimToken = payload.claim_token as string;
	let personaName: string | null = null;

	// P908-D: open offer_completed lifecycle span for the full spawn duration.
	// Best-effort — errors are swallowed inside ObservabilityWriter.
	const traceId = typeof payload.trace_id === "string" && payload.trace_id.length > 0
		? payload.trace_id
		: null;
	let completionSpanId: string | null = null;
	if (traceId) {
		const span = await obs.startSpan({
			traceId,
			operation: "offer_completed",
			attributes: { dispatch_id: dispatchId, agency_id: agencyId, offer_id: payload.offer_id },
		});
		completionSpanId = span.spanId;
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
		// Bug 8 fix (P1140-sib, 2026-05-19): per-agency provider selection.
		// Pre-P1132 each agency had its own systemd unit with
		// Environment=AGENTHIVE_AGENT_PROVIDER=<provider> in the unit file;
		// process.env worked per-agency. Post-P1132 all agencies share one
		// A2A host process — process.env is shared, so the env-var fallback
		// resolved to the same value for every agency (or unset, falling
		// through to route_hint='claude'). Result: codex/gemini/copilot
		// agencies all spawned claude binaries.
		//
		// Fix: read preferred_provider from agent_registry by agencyId at
		// spawn time. Per-process env vars still win as an operator override.
		let agencyProvider: string | null =
			process.env.AGENTHIVE_AGENT_PROVIDER?.trim() ||
			process.env.AGENCY_PROVIDER?.trim() ||
			null;
		if (!agencyProvider) {
			try {
				const { rows } = await query<{ preferred_provider: string | null }>(
					`SELECT preferred_provider FROM roadmap_workforce.agent_registry
					 WHERE agent_identity = $1 LIMIT 1`,
					[agencyId],
				);
				agencyProvider = rows[0]?.preferred_provider ?? null;
			} catch (err) {
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: preferred_provider lookup failed:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
		// Last-resort: orchestrator-sent route hint. Logged loudly because
		// arriving here means the agency lacks a preferred_provider AND no
		// process-wide override is set — the offer is at risk of running on
		// the wrong CLI (claude default).
		if (!agencyProvider) {
			agencyProvider = payload.route_hint;
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: no preferred_provider in agent_registry; falling back to route_hint='${payload.route_hint}'`,
			);
		}

		// P3795: Hard provider health gate. Block dispatch to providers whose P796
		// async probe returned 'timeout' or 'error'. Fail-open on absent/stale cache.
		const healthGate = isProviderHealthyForDispatch(agencyProvider, null);
		if (!healthGate.allowed) {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: provider health gate blocked dispatch to '${agencyProvider}' (status=${healthGate.status}, checkedAt=${healthGate.checkedAt})`,
			);
			clearInterval(renewalTimer);
			try {
				await exec(
					`INSERT INTO roadmap.escalation_log
					 (obstacle_type, agent_identity, escalated_to, severity, resolution_note)
					 VALUES ('PROVIDER_HEALTH_GATE', $1, 'orchestrator', 'low', $2)`,
					[
						agencyId,
						`Provider ${agencyProvider} blocked: health status=${healthGate.status} at ${healthGate.checkedAt}`,
					],
				);
			} catch (escErr) {
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: escalation_log INSERT failed (non-blocking):`,
					escErr instanceof Error ? escErr.message : escErr,
				);
			}
			await exec(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
				[dispatchId, agencyId, claimToken, "failed"],
			).catch((err) => {
				logger.error(
					`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed on health gate block:`,
					err instanceof Error ? err.message : err,
				);
			});
			return;
		}

		// P1113/P1392: resolve persona and build the enriched task string.
		// Prefer orchestrator-pre-resolved persona from payload; fall back to DB lookup.
		// P1392: For Claude, persona is passed separately to use --append-system-prompt.
		// For other providers, it is prepended to the task.
		const persona: string | null =
			typeof payload.persona === "string" && payload.persona.length > 0
				? payload.persona
				: await resolvePersonaByRoleName(payload.role, query as never).catch(() => null);

		// P1438 AC-9: a brain-supplied persona_name (from the self-claim matchmaker)
		// is the authoritative label for telemetry + control feed. Prefer it over
		// the file-resolver / role-name fallback below.
		if (typeof payload.persona_name === "string" && payload.persona_name.length > 0) {
			personaName = payload.persona_name;
		}

		// P1392: Track persona name/source for telemetry
		if (persona && !personaName) {
			// Try to extract persona name from file-based resolver first
			try {
				const { resolveFilePersona } = await import(
					"../../../core/orchestration/file-persona-resolver.ts"
				);
				const filePersona = await resolveFilePersona(payload.role);
				if (filePersona && filePersona.body === persona) {
					personaName = filePersona.personaName ?? payload.role;
				}
			} catch {
				// Fall back to role name for telemetry
				personaName = payload.role;
			}
			if (!personaName) {
				personaName = payload.role;
			}
		}

		const baseTask: string =
			typeof payload.task === "string" && payload.task.length > 0
				? payload.task
				: `Execute offer ${payload.offer_id} (role: ${payload.role})`;

		// P1392: Claude builder will use --append-system-prompt; don't prepend for claude
		const enrichedTask = agencyProvider === "claude" && persona
			? baseTask // Claude will get persona via --append-system-prompt
			: persona ? `${persona}\n\n${baseTask}` : baseTask;

		// P2335: ensure cubic worktree exists before spawn
		if (payload.cubic_id && worktree && worktree.startsWith("/data/code/worktree/")) {
			try {
				const { existsSync } = await import("node:fs");
				if (!existsSync(worktree)) {
					const { exec: cpExec } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execAsync = promisify(cpExec);
					const branchName = worktree.split("/").pop() || `auto-${Date.now()}`;
					// Assumes /data/code/AgentHive is the base repo
					await execAsync(`git worktree add ${worktree} -b ${branchName}`, { cwd: `/data/code/AgentHive` });
					logger.log(`[OfferDispatchHandler] provisioned project-scoped worktree ${worktree} for cubic=${payload.cubic_id}`);
				}
			} catch (err: any) {
				logger.warn(`[OfferDispatchHandler] failed to provision worktree ${worktree}: ${err?.message}`);
			}
		}

		// P1124 D4 Validator: Check if this is a gate-reviewer dispatch for a MERGE-stage proposal.
		// If so, run AC validation before spawning. advance=skip spawn (zero-token);
		// hold/reject=skip spawn + record decision; inconclusive=fall through to spawn (human review).
		if (proposalId && payload.role === "gate-reviewer") {
			try {
				// Look up proposal status to confirm it's MERGE stage
				const propRows = await exec(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposalId],
				);
				const propStatus = (propRows as any)?.rows?.[0]?.status;

				// Status values are stored UPPERCASE (e.g. 'MERGE').
				if (propStatus === "MERGE") {
					const validationResult = await validateProposal(proposalId, payload.trace_id ?? undefined);

					logger.log(
						`[OfferDispatchHandler] ${agencyId}: D4 validation for proposal ${proposalId}: decision=${validationResult.decision}`,
					);

					// If validator decided to advance, skip spawn entirely (zero-token) and mark completed
					if (validationResult.decision === "advance") {
						logger.log(
							`[OfferDispatchHandler] ${agencyId}: D4 advance → skipping spawn for offer=${payload.offer_id}`,
						);
						clearInterval(renewalTimer);
						await exec(
							`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
							[dispatchId, agencyId, claimToken, "delivered"],
						).catch((err) => {
							logger.error(
								`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed on D4-advance:`,
								err instanceof Error ? err.message : err,
							);
						});
						return;
					}

					// If validator decided to hold or reject, skip spawn but record the decision
					if (validationResult.decision === "hold" || validationResult.decision === "reject") {
						logger.log(
							`[OfferDispatchHandler] ${agencyId}: D4 ${validationResult.decision} → skipping spawn for offer=${payload.offer_id}`,
						);
						clearInterval(renewalTimer);
						await exec(
							`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
							[dispatchId, agencyId, claimToken, "failed"],
						).catch((err) => {
							logger.error(
								`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed on D4-hold/reject:`,
								err instanceof Error ? err.message : err,
							);
						});
						return;
					}

					// If inconclusive, fall through to normal spawn (human review via CLI)
					logger.log(
						`[OfferDispatchHandler] ${agencyId}: D4 inconclusive → proceeding to spawn for offer=${payload.offer_id}`,
					);
				}
			} catch (err) {
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: D4 validation failed for proposal ${proposalId}, falling through to spawn:`,
					err instanceof Error ? err.message : err,
				);
				// Fall through to normal spawn on validator error
			}
		}

		result = await spawn({
			worktree,
			task: enrichedTask,
			proposalId,
			stage: payload.role,
			capabilities,
			provider: agencyProvider as never,
			briefingId: payload.briefing_id,
			roleProfileId: payload.role_profile_id ?? null,
			timeoutMs: spawnTimeoutMs,
			// Use the agency's own name as the agent label so the spawned
			// subprocess claims proposals as "adam", "alan", etc. rather than
			// an auto-generated P852 structured identity string.
			agentLabel: agencyId,
			// P1392: For Claude, pass persona separately for --append-system-prompt injection.
			// Other providers prepend it to the task above.
			...(agencyProvider === "claude" && persona ? { persona, personaName } : {}),
		});
	} catch (err) {
		spawnError = err instanceof Error ? err : new Error(String(err));

		// P1360 Change 1 / AC-1/8: Wire spawn failure into agency throttle counters
		// so resolveAgency's ORDER BY throttle_count ASC de-prioritizes repeat failures.
		const errorClass = classifySpawnErrorClass(spawnError);
		void incrementSpawnFailure(agencyId, THROTTLE_THRESHOLD, errorClass).catch(
			(bumpErr) => {
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: failed to bump throttle counter for offer=${payload.offer_id}: ${bumpErr instanceof Error ? bumpErr.message : bumpErr}`,
				);
			},
		);

		// P914: surface the spawn failure cause so operators can diagnose
		// without grepping; previously the only signal was "exit=n/a".
		logger.error(
			`[OfferDispatchHandler] ${agencyId}: spawn threw for offer=${payload.offer_id} (role=${payload.role}, worktree=${worktree}, route_hint=${payload.route_hint}):`,
			spawnError.message,
		);
	}

	clearInterval(renewalTimer);

	// P2322 AC-4: Post-dispatch guard — verify primary checkout is clean
	try {
		void verifyAndRestorePrimaryCheckout(logger).catch((err) => {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: post-dispatch guard failed:`,
				err instanceof Error ? err.message : err,
			);
		});
	} catch {
		// ignore — guard is best-effort
	}

	// P908-B: combined stderr+stdout so we catch errors wherever they land.
	const fullOutput = [result?.stderr, result?.stdout].filter(Boolean).join("\n");

	// Exit-0 alone is NOT proof of work. A worker CLI with no auth (e.g. `agy`
	// missing its OAuth token) prints a login prompt and exits 0 having produced
	// nothing; an exit-0 run with completely empty output likewise did no work.
	// P2408: treat these "degenerate" exit-0 runs as failures, otherwise the
	// floor records fake `delivered` rows and starves healthy agencies (the
	// antigravity offer-sink). A real delivery = exit 0 AND not degenerate.
	const exitOk = spawnError === null && result?.exitCode === 0;
	let degenerateReason: "auth_required" | "empty_output" | null = null;
	if (exitOk) {
		if (classifyProviderSignal(fullOutput) === "auth_required") {
			degenerateReason = "auth_required";
		} else if (fullOutput.trim().length === 0) {
			degenerateReason = "empty_output";
		}
	}
	let succeeded = exitOk && degenerateReason === null;

	// P1438 AC-12/13 (C6 evidence-gated completion): exit-0 + non-degenerate output
	// is NECESSARY but NOT SUFFICIENT to mark an offer 'delivered'. A worker can
	// exit 0 with plausible output yet never write its role artifact (the
	// hallucinated-completion / codex-AC-fabrication pattern). Before delivery,
	// require canonical evidence for the offer's role: a proposal_reviews row for
	// gate/review roles, a commit/agent_runs row for build roles, AC/discussion
	// rows for enhance/architect roles (see deliverable-verifier ROLE_ARTIFACT_CHECKS
	// + normalizeDispatchRole). Missing evidence → NOT delivered (recorded failed,
	// does not advance the proposal); the reaper requeues per existing policy.
	// Fail closed: a verification error also blocks the delivered claim.
	let evidenceFailureReason: string | null = null;
	if (succeeded && proposalId) {
		try {
			const verdict = await verifyDeliverables({
				proposalId,
				dispatchRole: payload.role,
				workerIdentity: agencyId,
				dispatchId,
			});
			if (!verdict.verified) {
				succeeded = false;
				evidenceFailureReason =
					verdict.failureReason ?? `no deliverable artifact for role=${payload.role}`;
			}
		} catch (err) {
			succeeded = false;
			evidenceFailureReason = `evidence verification error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// P1018: Record token usage and cost from the spawn result.
	// This extracts provider-specific usage data, calculates cost, and
	// writes to agent_budget_ledger + agent_runs.tokens_in/out.
	// Non-fatal: failures here don't block offer completion.
	// (Must come AFTER `succeeded` is computed — the wave-4 merge placed it
	// before the declaration, a TDZ ReferenceError on every tracked run.)
	if (result?.agentRunId) {
		void recordSpawnUsage({
			agentRunId: result.agentRunId,
			proposalId,
			agencyIdentity: agencyId,
			modelUsed: payload.route_hint,
			provider: payload.route_hint,
			durationMs: result.durationMs,
			spawnResult: result,
			stage: payload.role,
			proposalStatus: null, // Populated at-write-time from DB if needed
			gateIdentity: null, // Populated if running in gate context
			agentRole: null, // Populated if role-based bucketing needed
			status: succeeded ? "completed" : "failed",
			exec,
		}).catch((err) => {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: recordSpawnUsage failed for run ${result.agentRunId}:`,
				err instanceof Error ? err.message : err,
			);
		});
	}
	const status: "delivered" | "failed" = succeeded ? "delivered" : "failed";
	const provider = payload.route_hint ?? null;

	if (degenerateReason) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: offer=${payload.offer_id} exited 0 but is DEGENERATE (${degenerateReason}) — recording FAILED, not delivered (route_hint=${payload.route_hint ?? "none"})`,
		);
	} else if (evidenceFailureReason) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: offer=${payload.offer_id} exited 0 but produced NO ROLE ARTIFACT (role=${payload.role}) — recording FAILED, not delivered. ${evidenceFailureReason}`,
		);
	}

	// P908-B: classify provider error signal and update provider_health.
	let providerSignal: string | null = null;
	if (!succeeded && provider) {
		try {
			providerSignal = classifyProviderSignal(fullOutput);
			if (providerSignal) {
				await setProviderCooldown(
					provider,
					providerSignal as ProviderSignal,
					fullOutput,
				);
			}
		} catch {
			/* best-effort — don't block offer completion */
		}
	} else if (succeeded && provider) {
		try {
			await recordProviderSuccess(provider);
		} catch {
			/* best-effort */
		}
	}

	// P908-B: persist provider_signal on the dispatch row for auditability.
	// P1392 AC-5: Also persist persona_used in metadata for telemetry.
	if (providerSignal || personaName) {
		try {
			const updateParts = [];
			const updateValues = [];
			const metadataEntries: string[] = [];
			const providerSignalColumnExists = providerSignal
				? await hasSquadDispatchProviderSignalColumn(exec)
				: false;
			if (providerSignal && providerSignalColumnExists) {
				updateParts.push("provider_signal = $" + (updateValues.length + 1) + "::text");
				updateValues.push(providerSignal);
			}
			if (providerSignal && !providerSignalColumnExists) {
				metadataEntries.push(
					"'provider_signal', $" + (updateValues.length + 1) + "::text",
				);
				updateValues.push(providerSignal);
			}
			if (personaName) {
				metadataEntries.push(
					"'persona_used', $" + (updateValues.length + 1) + "::text",
				);
				updateValues.push(personaName);
			}
			if (metadataEntries.length > 0) {
				updateParts.push(
					`metadata = metadata || jsonb_build_object(${metadataEntries.join(", ")})`,
				);
			}
			updateValues.push(dispatchId);

			if (updateParts.length > 0) {
				await exec(
					`UPDATE roadmap_workforce.squad_dispatch
					    SET ${updateParts.join(", ")}
					  WHERE id = $${updateValues.length}`,
					updateValues,
				);
			}
		} catch (err) {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: failed to update telemetry for dispatch ${dispatchId}:`,
				err instanceof Error ? err.message : err,
			);
			/* best-effort */
		}
	}

	// AC-5: emit a structured spawn_failure uplink so the orchestrator can
	// observe the failure as an operational fact. Lifecycle is still governed
	// mechanically by fn_complete_work_offer below; the uplink is informational.
	if (status === "failed") {
		sendUplink({
			agency_id: agencyId,
			direction: "liaison->orchestrator",
			kind: "spawn_failure",
			payload: {
				dispatch_id: dispatchId,
				offer_id: payload.offer_id,
				role: payload.role,
				error_message: spawnError?.message ?? `exit=${result?.exitCode ?? "n/a"}`,
				exit_code: result?.exitCode ?? null,
			},
		}).catch((err) => {
			logger.warn(
				`[OfferDispatchHandler] ${agencyId}: spawn_failure uplink failed for offer=${payload.offer_id}:`,
				err instanceof Error ? err.message : err,
			);
		});
	}

	// P1682 AC-4: Detect rate_limited exit and decide hold vs provider cooldown
	// If the spawn failed with a quota signal, classify the exit and measure the reset duration
	let holdPlaced = false;
	if (!succeeded && result) {
		const exitClass = classifyExit(result.stdout, result.stderr, result.exitCode);
		if (exitClass.outcome === "rate_limited" && exitClass.resetAt && exitClass.quotaErrorProvider) {
			const HOLD_WINDOW_MAX_SEC =
				(await config.getOptional(FlagKeys.AGENTHIVE_HOLD_WINDOW_MAX_SEC)) ?? 1800;
			const deltaMs = exitClass.resetAt.getTime() - Date.now();
			const deltaSec = Math.ceil(deltaMs / 1000);

			// AC-4 & AC-5: Short reset (<= HOLD_WINDOW_MAX_SEC) — place in hold state
			// AC-8: Held dispatch is NOT marked failed, NOT increments failure_count
			if (deltaSec <= HOLD_WINDOW_MAX_SEC) {
				try {
					await recordProviderHardLimit(agencyId, dispatchId, exitClass.resetAt, exec);
					holdPlaced = true;
					logger.log(
						`[OfferDispatchHandler] ${agencyId}: P1682 AC-4 hold placed — paused_at_provider_limit=true, resume_eligible_at=${exitClass.resetAt.toISOString()}, deltaSec=${deltaSec}`,
					);
					// AC-8: Skip fn_complete_work_offer for held dispatches — lease remains
					// active and will be cleared by wake sweep when resume_eligible_at expires
				} catch (err) {
					logger.error(
						`[OfferDispatchHandler] ${agencyId}: recordProviderHardLimit failed for offer=${payload.offer_id}:`,
						err instanceof Error ? err.message : err,
					);
					// Fall through to fn_complete_work_offer with "failed" status on error
				}
			} else {
				// Long reset (>= HOLD_WINDOW_MAX_SEC) — route/provider cooldown already set in spawnWithRetry
				logger.log(
					`[OfferDispatchHandler] ${agencyId}: P1682 AC-9 long reset — deltaSec=${deltaSec} exceeds HOLD_WINDOW_MAX_SEC=${HOLD_WINDOW_MAX_SEC}, cooldown already applied`,
				);
			}
		}
	}

	// Only call fn_complete_work_offer if we did NOT place a hold
	// Held dispatches remain in 'claimed' state with paused_at_provider_limit=true
	// and will be woken by the reaper when resume_eligible_at expires
	if (!holdPlaced) {
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

	// P908-D: close the lifecycle span now that fn_complete_work_offer has run.
	if (completionSpanId) {
		void obs.closeSpan({
			spanId: completionSpanId,
			status: succeeded ? "ok" : "error",
			errorMessage: spawnError?.message ?? null,
		});
	}

	// P908-B: notify orchestrator of offer completion so it can react to
	// provider signals without polling squad_dispatch.
	try {
		const notifyPayload = JSON.stringify({
			dispatch_id: dispatchId,
			agency_id: agencyId,
			provider,
			signal: providerSignal,
			exit_code: result?.exitCode ?? null,
		});
		await exec(`SELECT pg_notify('offer_completed', $1)`, [notifyPayload]);
	} catch {
		/* best-effort — orchestrator's poll will still recover */
	}
}

// ── Usage-limit pause helpers ─────────────────────────────────────────────────

interface AgencyMetadataRow {
	paused_until: string | null;
}

/**
 * Look up roadmap_workforce.provider_registry.max_in_flight for the agency.
 * Cached briefly per agency to avoid hammering the DB on every dispatch.
 * On any error (missing row, transient DB issue), defaults to 1 — strictest
 * gate, fail-safe.
 */
const MAX_IN_FLIGHT_CACHE_MS = 30_000;
const maxInFlightCache = new Map<string, { value: number; expiresAt: number }>();

/** @internal — reset for tests. */
export function _resetMaxInFlightCacheForTest(): void {
	maxInFlightCache.clear();
}

export async function readAgencyMaxInFlight(
	agencyId: string,
	exec: SqlExec,
	logger: Pick<Console, "log" | "warn" | "error">,
): Promise<number> {
	const now = Date.now();
	const cached = maxInFlightCache.get(agencyId);
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}
	try {
		const result = (await exec(
			`SELECT pr.max_in_flight
			 FROM roadmap_workforce.provider_registry pr
			 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			 WHERE ar.agent_identity = $1
			 ORDER BY pr.id DESC
			 LIMIT 1`,
			[agencyId],
		)) as { rows: Array<{ max_in_flight: number }> } | undefined;
		const value = result?.rows?.[0]?.max_in_flight ?? 1;
		maxInFlightCache.set(agencyId, { value, expiresAt: now + MAX_IN_FLIGHT_CACHE_MS });
		return value;
	} catch (err) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: readAgencyMaxInFlight failed; defaulting to 1:`,
			err instanceof Error ? err.message : err,
		);
		return 1;
	}
}

/**
 * Read roadmap.agency.metadata->>'paused_until' for this agency. Returns null
 * if the agency row is missing, the field is unset, or the value is not a
 * parseable timestamp. Errors are logged but never thrown — a transient DB
 * issue here should NOT prevent the agency from claiming work.
 */
async function readAgencyPausedUntil(
	agencyId: string,
	exec: SqlExec,
	logger: Pick<Console, "log" | "warn" | "error">,
): Promise<Date | null> {
	try {
		const result = (await exec(
			`SELECT (metadata->>'paused_until') AS paused_until
			 FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		)) as { rows: AgencyMetadataRow[] } | undefined;
		const raw = result?.rows?.[0]?.paused_until;
		if (!raw) return null;
		const d = new Date(raw);
		return Number.isNaN(d.getTime()) ? null : d;
	} catch (err) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: readAgencyPausedUntil failed:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Upsert a row in roadmap.host_model_route_throttle. Pure observability +
 * forward-compat: postWorkOffer reads this when it has a model in hand, and
 * any operator query against this table sees the live throttle state.
 */
async function applyThrottle(
	exec: SqlExec,
	provider: UsageLimitProvider | string,
	model: string,
	seconds: number,
	reason: string,
): Promise<void> {
	await exec(
		`INSERT INTO roadmap.host_model_route_throttle (provider, model, throttled_until, reason)
		 VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4)
		 ON CONFLICT (provider, model) DO UPDATE
		   SET throttled_until = GREATEST(host_model_route_throttle.throttled_until, EXCLUDED.throttled_until),
		       reason          = EXCLUDED.reason,
		       updated_at      = clock_timestamp()`,
		[provider, model, String(seconds), reason],
	);
}

/**
 * Set roadmap.agency.metadata.paused_until = now() + seconds. The pause is
 * checked at the top of handleOfferDispatch so the agency declines to spawn
 * any new offer until the timestamp passes. The pause clears itself naturally
 * (the next offer-dispatch sees the past timestamp and proceeds).
 */
async function pauseAgency(
	exec: SqlExec,
	agencyId: string,
	seconds: number,
	reason: string,
): Promise<void> {
	await exec(
		`UPDATE roadmap.agency
		    SET metadata = metadata || jsonb_build_object(
		                     'paused_until', to_jsonb((now() + ($2 || ' seconds')::interval)::text),
		                     'pause_reason', to_jsonb($3::text),
		                     'paused_at',    to_jsonb(now()::text)
		                   )
		  WHERE agency_id = $1`,
		[agencyId, String(seconds), reason],
	);
}

/**
 * P2322 AC-4: Post-dispatch guard — verify that the primary checkout
 * (/data/code/AgentHive) is still on `main` with a clean working tree.
 *
 * If a sub-agent leaves the primary checkout on a feature branch or with
 * uncommitted files, auto-restore and emit a WARNING. This is a safety net
 * against agents contaminating the shared dev environment.
 *
 * This is best-effort — failures are logged but don't block offer completion.
 */
async function verifyAndRestorePrimaryCheckout(
	logger: Pick<Console, "log" | "warn" | "error">,
): Promise<void> {
	const { execSync } = await import("node:child_process");
	const PRIMARY_CHECKOUT = "/data/code/AgentHive";

	try {
		// Check if primary checkout exists
		try {
			await import("fs/promises").then((fs) =>
				fs.access(PRIMARY_CHECKOUT, 0x0), // F_OK = 0x0
			);
		} catch {
			// Primary doesn't exist or not accessible; skip check
			return;
		}

		// Check current branch
		const branch = execSync(`cd ${PRIMARY_CHECKOUT} && git rev-parse --abbrev-ref HEAD`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"], // suppress stderr
		})
			.trim();

		if (branch !== "main") {
			logger.warn(
				`[P2322 AC-4] Primary checkout on branch "${branch}", not "main" — auto-restoring to main`,
			);
			try {
				execSync(`cd ${PRIMARY_CHECKOUT} && git checkout main`, {
					stdio: "pipe",
				});
			} catch (err) {
				logger.error(
					`[P2322 AC-4] Failed to checkout main in primary:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		// Check for dirty files
		const dirtyOutput = execSync(`cd ${PRIMARY_CHECKOUT} && git status --porcelain`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (dirtyOutput.trim()) {
			logger.warn(
				`[P2322 AC-4] Primary checkout has uncommitted changes — auto-cleaning with 'git clean -fd'`,
			);
			try {
				execSync(`cd ${PRIMARY_CHECKOUT} && git clean -fd`, {
					stdio: "pipe",
				});
			} catch (err) {
				logger.error(
					`[P2322 AC-4] Failed to clean primary:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	} catch (err) {
		// Best-effort; don't block completion
		logger.warn(
			`[P2322 AC-4] Post-dispatch guard check failed (this is informational):`,
			err instanceof Error ? err.message : err,
		);
	}
}
