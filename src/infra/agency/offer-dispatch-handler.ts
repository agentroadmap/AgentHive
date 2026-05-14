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
import { sendMessage } from "./liaison-message-service.ts";
import {
	detectUsageLimit,
	isLongWindow,
	resetSecondsForSignal,
	type UsageLimitProvider,
} from "./usage-limit-detector.ts";

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
	/** P771: role_profile.id for route-policy filtering in spawnAgent. */
	role_profile_id?: number | null;
}

const DEFAULT_LEASE_TTL_SECONDS = 60;

/**
 * Per-process single-active-spawn invariant.
 *
 * An agency is one process; one process focuses on one CLI subprocess at a
 * time. When an offer_dispatch arrives while a prior spawn is still running,
 * we refuse the new claim (complete-as-failed) so the reaper requeues the
 * offer and another idle agency claims it.
 *
 * This is stronger than `max_in_flight`: it eliminates concurrency entirely
 * at the agency boundary. The orchestrator's global cap bounds total work
 * in the system; this invariant bounds work per agency to exactly one.
 *
 * Module-level state: each agency runs in its own Node process, so the
 * variable is naturally per-agency. Test injection overrides it to keep
 * tests deterministic.
 */
let activeSpawn: Promise<unknown> | null = null;

/** @internal — reset for tests that share module state. */
export function _resetActiveSpawnForTest(): void {
	activeSpawn = null;
}

/** @internal — peek for tests. */
export function _activeSpawnForTest(): Promise<unknown> | null {
	return activeSpawn;
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

	// Single-active-spawn invariant: an agency processes one offer at a time.
	// Reject the new offer immediately so the reaper requeues it to an idle
	// agency rather than queuing locally or running concurrent spawns.
	if (activeSpawn !== null) {
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: busy with prior spawn; declining offer=${payload.offer_id} role=${payload.role}`,
		);
		await exec(
			`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
			[payload.dispatch_id, agencyId, payload.claim_token, "failed"],
		).catch((err) => {
			logger.error(
				`[OfferDispatchHandler] ${agencyId}: fn_complete_work_offer failed on busy-decline:`,
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

	// Reserve the agency for this spawn. The `finally` clears the slot whether
	// the spawn succeeds, fails, throws, or times out — so the agency cannot
	// get stuck "busy" if the runSpawn pipeline misbehaves.
	activeSpawn = spawnPromise.finally(() => {
		activeSpawn = null;
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

	// Usage-limit detection: scan spawn output for known provider limit
	// signals (codex "hit your usage limit", claude/gemini/copilot equivalents).
	// On detection: throttle the route AND, for long-window resets (>2h or
	// unknown), also pause this agency in DB so it stops claiming until reset.
	const provider =
		(process.env.AGENTHIVE_AGENT_PROVIDER?.trim() ||
			process.env.AGENCY_PROVIDER?.trim() ||
			payload.route_hint) as string | undefined;
	const limitSignal = detectUsageLimit({
		stdout: result?.stdout,
		stderr: result?.stderr,
		errorMessage: spawnError?.message,
		defaultProvider: provider,
	});
	if (limitSignal) {
		const seconds = resetSecondsForSignal(limitSignal);
		const long = isLongWindow(limitSignal);
		logger.warn(
			`[OfferDispatchHandler] ${agencyId}: usage-limit detected (${limitSignal.reason}); throttle ${limitSignal.provider}/${limitSignal.model} for ${seconds}s; ${long ? "PAUSE agency (long-window)" : "route-throttle only (short-window)"}`,
		);
		await applyThrottle(exec, limitSignal.provider, limitSignal.model, seconds, limitSignal.reason).catch(
			(err) =>
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: throttle upsert failed:`,
					err instanceof Error ? err.message : err,
				),
		);
		if (long) {
			await pauseAgency(exec, agencyId, seconds, limitSignal.reason).catch((err) =>
				logger.warn(
					`[OfferDispatchHandler] ${agencyId}: pauseAgency failed:`,
					err instanceof Error ? err.message : err,
				),
			);
		}
	}

	const status: "delivered" | "failed" =
		spawnError === null && (result?.exitCode === 0 || result?.exitCode === null)
			? "delivered"
			: "failed";

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
}

// ── Usage-limit pause helpers ─────────────────────────────────────────────────

interface AgencyMetadataRow {
	paused_until: string | null;
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
