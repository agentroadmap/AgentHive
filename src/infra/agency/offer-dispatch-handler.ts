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
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import {
	classifyProviderSignal,
	setProviderCooldown,
	recordProviderSuccess,
} from "../../core/orchestration/provider-cooldown.ts";
import { ObservabilityWriter } from "../../core/observability/observability-writer.ts";

const obs = new ObservabilityWriter("offer-dispatch-handler");

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
	/** P908-D: trace correlation UUID threaded from postWorkOffer. */
	trace_id?: string | null;
}

const DEFAULT_LEASE_TTL_SECONDS = 60;

/**
 * Per-agency concurrent-spawn counter (per-process module-level state).
 *
 * Each agency runs in its own Node process; this counter tracks the number of
 * in-flight runSpawn promises for the local agency. The threshold is read
 * from roadmap_workforce.provider_registry.max_in_flight per offer so an
 * operator can tune the per-agency cap via SQL without restart.
 *
 * Semantics (per operator policy 2026-05-14):
 *   "Claim is calculated intention; if there is an obstacle, an agency can
 *    regret and return the offer."
 *
 * When activeSpawnCount >= max_in_flight at the moment a dispatch arrives,
 * the handler calls fn_return_work_offer (NOT fn_complete_work_offer with
 * 'failed'). fn_return_work_offer reverts offer_status from 'claimed' to
 * 'open', does not increment reissue_count, and emits work_offers notify so
 * any other idle agency picks it up immediately.
 */
let activeSpawnCount = 0;

/** @internal — reset for tests that share module state. */
export function _resetActiveSpawnForTest(): void {
	activeSpawnCount = 0;
}

/** @internal — peek for tests. */
export function _activeSpawnCountForTest(): number {
	return activeSpawnCount;
}

const defaultExec: SqlExec = (sql, params) =>
	query(sql, params as unknown[]);

const defaultDeps: Required<
	Pick<
		OfferDispatchHandlerDeps,
		"spawn" | "exec" | "logger" | "resolveWorktree"
	>
> = {
	spawn: spawnAgent,
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

	// Capacity gate: if this agency is at or above its max_in_flight threshold
	// (configured per-agency in provider_registry), return the offer instead
	// of accepting it. fn_return_work_offer flips offer_status back to 'open',
	// rotates the claim token, and pg_notify's the claim loop so an idle
	// agency picks it up. No reissue penalty, no failure metric pollution.
	const maxInFlight = await readAgencyMaxInFlight(agencyId, exec, logger);
	if (activeSpawnCount >= maxInFlight) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: at capacity (${activeSpawnCount}/${maxInFlight}); returning offer=${payload.offer_id} role=${payload.role}`,
		);
		await exec(
			`SELECT roadmap_workforce.fn_return_work_offer($1, $2, $3, $4)`,
			[
				payload.dispatch_id,
				agencyId,
				payload.claim_token,
				`agency_at_capacity:${activeSpawnCount}/${maxInFlight}`,
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
	activeSpawnCount++;
	spawnPromise.finally(() => {
		activeSpawnCount = Math.max(0, activeSpawnCount - 1);
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
		// Prefer the agency's own AGENTHIVE_AGENT_PROVIDER / AGENCY_PROVIDER env
		// over the orchestrator-sent route_hint. The orchestrator defaults the hint
		// to "claude" when the offer carries no provider preference, which would
		// cause codex/gemini/copilot agencies to spawn claude processes instead of
		// their own configured provider.
		const agencyProvider =
			(process.env.AGENTHIVE_AGENT_PROVIDER?.trim() ||
				process.env.AGENCY_PROVIDER?.trim() ||
				payload.route_hint) as never;

		result = await spawn({
			worktree,
			task: `Execute offer ${payload.offer_id} (role: ${payload.role})`,
			proposalId,
			stage: payload.role,
			capabilities,
			provider: agencyProvider,
			briefingId: payload.briefing_id,
			roleProfileId: payload.role_profile_id ?? null,
			timeoutMs: spawnTimeoutMs,
			// Use the agency's own name as the agent label so the spawned
			// subprocess claims proposals as "adam", "alan", etc. rather than
			// an auto-generated P852 structured identity string.
			agentLabel: agencyId,
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

	const succeeded =
		spawnError === null && (result?.exitCode === 0 || result?.exitCode === null);
	const status: "delivered" | "failed" = succeeded ? "delivered" : "failed";
	const provider = payload.route_hint ?? null;

	// P908-B: classify provider error signal and update provider_health.
	// Use the combined stderr+stdout text so we catch errors wherever they land.
	const fullOutput = [result?.stderr, result?.stdout].filter(Boolean).join("\n");
	let providerSignal: string | null = null;
	if (!succeeded && provider) {
		try {
			providerSignal = classifyProviderSignal(fullOutput);
			if (providerSignal) {
				await setProviderCooldown(
					provider,
					providerSignal as "rate_limit" | "credit_exhausted",
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
	if (providerSignal) {
		try {
			await exec(
				`UPDATE roadmap_workforce.squad_dispatch
				    SET provider_signal = $1
				  WHERE id = $2`,
				[providerSignal, dispatchId],
			);
		} catch {
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
 * Cached briefly per process to avoid hammering the DB on every dispatch.
 * On any error (missing row, transient DB issue), defaults to 1 — strictest
 * gate, fail-safe.
 */
const MAX_IN_FLIGHT_CACHE_MS = 30_000;
let maxInFlightCache: { value: number; expiresAt: number } | null = null;

/** @internal — reset for tests. */
export function _resetMaxInFlightCacheForTest(): void {
	maxInFlightCache = null;
}

async function readAgencyMaxInFlight(
	agencyId: string,
	exec: SqlExec,
	logger: Pick<Console, "log" | "warn" | "error">,
): Promise<number> {
	const now = Date.now();
	if (maxInFlightCache && maxInFlightCache.expiresAt > now) {
		return maxInFlightCache.value;
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
		maxInFlightCache = { value, expiresAt: now + MAX_IN_FLIGHT_CACHE_MS };
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
