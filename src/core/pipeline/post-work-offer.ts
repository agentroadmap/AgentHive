/**
 * postWorkOffer — shared utility for posting a work offer to squad_dispatch.
 *
 * Used by the unified Orchestrator for agent dispatch. Posting an offer
 * decouples the caller from knowing which CLI or binary path to use —
 * the agency that claims the offer handles that.
 *
 * P437: every INSERT computes a deterministic idempotency_key over
 * (project_id, proposal_id, workflow_state, maturity, role, dispatch_version).
 * The partial UNIQUE INDEX over alive (open|assigned|active) rows means
 * concurrent callers collide on the same key — the loser's INSERT becomes a
 * DO UPDATE that bumps attempt_count and surfaces reason='replay' so the
 * feed shows the de-duplication.
 */

import { createHash, randomUUID } from "node:crypto";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import { ObservabilityWriter } from "../observability/observability-writer.ts";
import { ROLE_TO_REQUIRED_CAPABILITIES } from "../orchestration/offer-dispatch.ts";
import {
	assessDifficulty,
	isTaskClass,
	type CapabilityTier,
	type TaskClass,
} from "../orchestration/difficulty-assessor.ts";
import { autoCharterIfNeeded } from "./auto-charter.ts";

const obs = new ObservabilityWriter("agency:offer-pipeline");

export type QueryFn = typeof defaultQuery;

/**
 * P689 hotfix: cap repeat (proposal, role) work-offer postings.
 *
 * The existing idempotency_key + partial unique index on squad_dispatch only
 * deduplicates against *currently alive* dispatches. Once a previous
 * dispatch completes, the next post is a clean INSERT — so a worker loop
 * that completes-but-doesn't-progress (P687: 60 triage runs in 2h15m)
 * generates an unbounded billable stream.
 *
 * The breaker counts agent_runs (truth-of-execution; outlives squad_dispatch
 * reaping) for the same (proposal_id, role-or-stage) over the last hour.
 * Above the threshold, refuse the post and pause the proposal.
 */
const DISPATCH_LOOP_THRESHOLD_PER_HOUR = Number(
	process.env.AGENTHIVE_DISPATCH_LOOP_THRESHOLD ?? "6",
);

/**
 * P1729: Cumulative gate convergence guard. Complements the per-hour breaker
 * by tracking accumulated blocking reviews and per-role dispatch attempts
 * since the last state or maturity transition.
 *
 * When blocking-review count >= K or per-role run count >= N, the proposal
 * is paused. Resets on state/maturity transition.
 */
const GATE_CONVERGENCE_MAX_BLOCKING = Number(
	process.env.AGENTHIVE_GATE_CONVERGENCE_MAX_BLOCKING ?? "3",
);

const GATE_CONVERGENCE_MAX_RUNS_PER_ROLE = Number(
	process.env.AGENTHIVE_GATE_CONVERGENCE_MAX_RUNS_PER_ROLE ?? "8",
);

/**
 * P3311: proactive premature-maturity guard (see PrematureGateError). Enabled
 * by default; set AGENTHIVE_PREMATURE_GATE_GUARD_ENABLED=false to disable (e.g.
 * if a workflow legitimately matures proposals before any AC is marked passing).
 */
const PREMATURE_GATE_GUARD_ENABLED =
	(process.env.AGENTHIVE_PREMATURE_GATE_GUARD_ENABLED ?? "true").toLowerCase() !==
	"false";

/**
 * Global cap on alive offers (open or claimed-but-not-completed) across the
 * whole orchestrator. The orchestrator otherwise tends to fan out 80–100 offers
 * in seconds, exhausting agency capacity and starting Claude subprocesses that
 * can't all complete before the next tick — burning budget on offers no one can
 * service. With a cap, postWorkOffer becomes backpressure-aware: once the
 * queue is full, new posts are rejected until existing offers complete via
 * fn_complete_work_offer or fn_reap_expired_offers reissues stale leases.
 *
 * Phase 1 (hot-configurable): the cap is read per call from the
 * ORCHESTRATOR_MAX_INFLIGHT_OFFERS runtime flag via the config resolver, which
 * caches the value and clears it on `runtime_flag_changed` NOTIFY. So
 * `UPDATE core.runtime_flag SET value_jsonb='8' WHERE
 *  flag_name='ORCHESTRATOR_MAX_INFLIGHT_OFFERS'` takes effect on the next
 * dispatch with NO orchestrator restart. Set to 0 to disable backpressure.
 *
 * Legacy AGENTHIVE_MAX_INFLIGHT_OFFERS env is honored ONLY as a fallback when
 * the flag row is absent, so existing deployments keep working until the
 * migration seeds the flag.
 */
async function resolveMaxGlobalInflightOffers(): Promise<number> {
	try {
		return await runtimeConfig.get(FlagKeys.ORCHESTRATOR_MAX_INFLIGHT_OFFERS);
	} catch {
		// Config layer unavailable (e.g. unit tests with no DB) — fall back to the
		// legacy env, then the historical default.
		const env = process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS;
		const n = env !== undefined ? Number(env) : 20;
		return Number.isFinite(n) ? n : 20;
	}
}

export class DispatchLoopError extends Error {
	constructor(
		readonly proposalId: number,
		readonly role: string,
		readonly recentRuns: number,
	) {
		super(
			`postWorkOffer: circuit breaker tripped for proposal ${proposalId} role=${role} (${recentRuns} runs in last hour > threshold ${DISPATCH_LOOP_THRESHOLD_PER_HOUR}). gate_scanner_paused=true.`,
		);
		this.name = "DispatchLoopError";
	}
}

export class BackpressureError extends Error {
	constructor(
		readonly inflight: number,
		readonly cap: number,
	) {
		super(
			`postWorkOffer: backpressure — ${inflight} offers in flight (cap=${cap}). New posts paused until existing offers complete or the reaper requeues stale leases.`,
		);
		this.name = "BackpressureError";
	}
}

export class CapabilityMismatchError extends Error {
	constructor(
		readonly proposalId: number,
		readonly role: string,
		readonly requiredCapabilities: string[],
	) {
		super(
			`postWorkOffer: P${proposalId}: no active agency advertises required capabilities ${JSON.stringify(requiredCapabilities)} for role "${role}" via provider_registry.capabilities->'jobs'. Offer not inserted. Investigate role-to-capability mapping (P1290) or seed missing capabilities on an active agency.`,
		);
		this.name = "CapabilityMismatchError";
	}
}

export class PausedRoleError extends Error {
	constructor(
		readonly proposalId: number,
		readonly role: string,
		readonly reason: string,
		readonly expiresAt: Date,
	) {
		super(
			`postWorkOffer: P${proposalId} role=${role} paused (reason=${reason}, resumes=${expiresAt.toISOString()})`,
		);
		this.name = "PausedRoleError";
	}
}

// P1393: postWorkOffer refused because the proposal carries
// gate_scanner_paused=true (operator pause or circuit-breaker pause).
// scanQueues / legacy-dispatch treat this as skip-and-continue, same shape
// as PausedRoleError. Without this guard, scanQueues would dispatch into a
// paused proposal every tick and the circuit breaker would re-fire alerts.
export class ProposalPausedError extends Error {
	constructor(
		readonly proposalId: number,
		readonly pausedBy: string | null,
		readonly pausedAt: Date | null,
	) {
		super(
			`postWorkOffer: P${proposalId} dispatch refused — gate_scanner_paused=true (by=${pausedBy ?? "unknown"}, since=${pausedAt?.toISOString() ?? "unknown"})`,
		);
		this.name = "ProposalPausedError";
	}
}

// Offer-gen guard: COMPLETE is a terminal state — never post work offers for
// a completed proposal (operator directive 2026-06-09). scanQueues/legacy-dispatch
// treat this as skip-and-continue, same shape as ProposalPausedError.
//
// P2496: single source of truth for terminal proposal statuses. Reused by the
// AC-1 guard below, by legacy-dispatch.handleStateChange (AC-5), and by the
// liaison A2A task bridge (AC-4) so the "no offers for terminal proposals"
// invariant is enforced at every offer-creation site, not duplicated.
export const TERMINAL_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETE",
]);

/** True when `status` is a terminal proposal state (case-insensitive). */
export function isTerminalProposalStatus(
	status: string | null | undefined,
): boolean {
	return !!status && TERMINAL_PROPOSAL_STATUSES.has(status.toUpperCase());
}

export class TerminalProposalError extends Error {
	constructor(
		readonly proposalId: number,
		readonly status: string,
	) {
		super(
			`postWorkOffer: P${proposalId} dispatch refused — proposal status='${status}' is terminal (COMPLETE); no offers for completed proposals.`,
		);
		this.name = "TerminalProposalError";
	}
}

// P1729: postWorkOffer refused because cumulative convergence guard
// detected either (a) blocking review count >= K, or (b) per-role run count >= N
// since last state/maturity transition. Proposal is paused.
export class ConvergenceGuardError extends Error {
	constructor(
		readonly proposalId: number,
		readonly blockingCount: number | null,
		readonly runsCount: number | null,
		readonly maxBlocking: number,
		readonly maxRunsPerRole: number,
	) {
		const reasons = [];
		if (blockingCount !== null && blockingCount >= maxBlocking) {
			reasons.push(`blocking reviews: ${blockingCount} >= ${maxBlocking}`);
		}
		if (runsCount !== null && runsCount >= maxRunsPerRole) {
			reasons.push(`per-role runs: ${runsCount} >= ${maxRunsPerRole}`);
		}
		super(
			`postWorkOffer: convergence guard tripped for proposal ${proposalId} (${reasons.join(", ")}). gate_scanner_paused=true.`,
		);
		this.name = "ConvergenceGuardError";
	}
}

// P3311: proactive premature-maturity guard. A proposal sitting in DEVELOP
// with maturity='mature' but ZERO passing acceptance criteria (while it DOES
// have ACs) was never actually built — it was matured by mistake (a closer
// marking it done without delivering, or a gate batch advancing it). The D3
// gate then fires its decider role (skeptic-beta) every scan; the gate
// correctly HOLDs ("no code exists") but a hold doesn't demote maturity, so it
// re-gates forever until a *reactive* breaker (DispatchLoopError /
// ConvergenceGuardError) trips after burning 6+ wasted runs and pauses the
// proposal — which then needs a manual operator unpause.
//
// This guard fires BEFORE the reactive breakers: it refuses the gate offer and
// demotes maturity back to 'new', which routes the proposal to a DEVELOPER on
// the next scan (DEVELOP/new dispatches dev roles, DEVELOP/mature dispatches
// gate roles). Self-healing, no operator toil, no wasted gate runs.
//
// Deliberately NOT pausing: pause halts and waits for a human; demote re-routes
// to productive work. Deliberately keyed on passing-AC count (DB-truth) not git
// commits (not DB-visible from here) — a proposal with passing ACs but a stuck
// gate (e.g. P1438: gate worker confabulates its verdict) is a DIFFERENT bug
// (artifact-persistence gap) and is left alone by this guard.
export class PrematureGateError extends Error {
	constructor(
		readonly proposalId: number,
		readonly role: string,
		readonly totalAcs: number,
	) {
		super(
			`postWorkOffer: P${proposalId} role=${role} refused — DEVELOP/mature with 0/${totalAcs} passing acceptance criteria (premature maturity). Demoted maturity to 'new' to route to a developer.`,
		);
		this.name = "PrematureGateError";
	}
}

export interface WorkOfferInput {
	proposalId: number;
	squadName: string;
	role: string;
	task: string;
	stage?: string;
	phase?: string;
	model?: string;
	timeoutMs?: number;
	worktreeHint?: string;
	requiredCapabilities?: string[];
	/**
	 * P466 spawn-briefing: identifier of the warm-boot briefing assembled by
	 * the parent (orchestrator) before posting the offer. The agency claims
	 * the offer, reads briefing_id from metadata, and passes it to the
	 * spawned child via AGENTHIVE_BRIEFING_ID env. The child calls
	 * `briefing_load(<id>)` on boot to retrieve mission, success criteria,
	 * allowed tools, MCP quirks, and escalation channels.
	 */
	briefingId?: string;
	/**
	 * P437 idempotency: when set, callers can advance the dispatch_version to
	 * force a fresh dispatch row even if a prior one for the same logical
	 * (proposal, status, maturity, role) already exists. Defaults to 1.
	 */
	dispatchVersion?: number;
	/**
	 * P771 role-policy: DB id of the role_profile row driving allowed/forbidden
	 * provider filters. Stored in offer metadata and forwarded to spawnAgent by
	 * the liaison's OfferDispatchHandler so route resolution applies the same
	 * policy that scanQueues() would have applied on a direct spawn.
	 */
	roleProfileId?: number | null;
	/**
	 * P1292: Gate metadata fields for implicit-gate dispatch through offer lifecycle.
	 * When set, these fields are copied to metadata jsonb for gate completion listener.
	 */
	gateRole?: string | null;
	gateFromStage?: string | null;
	gateToStage?: string | null;
	gateRoleSource?: string | null;
	/**
	 * P3310 AC-3: explicit operator/proposal overrides. When set to a legal
	 * value, the difficulty assessor honors these over its heuristic so a
	 * proposal can pin a tier or task_class. Left undefined for the normal
	 * heuristic path.
	 */
	tierOverride?: CapabilityTier | null;
	taskClassOverride?: TaskClass | null;
}

export interface WorkOfferResult {
	dispatchId: number;
	/** True when the INSERT collided with an existing alive dispatch row. */
	replay: boolean;
	/** Total number of times this idempotency_key has been posted. */
	attemptCount: number;
	/** P908-D: UUID threaded through the offer pipeline for observability trace correlation. */
	traceId: string;
	/** P3314: true when posting was skipped because a live offer already exists
	 *  for this (proposal_id, role). dispatchId points at the existing offer. */
	deduped?: boolean;
}

function computeIdempotencyKey(parts: {
	projectId: number | null;
	proposalId: number;
	status: string;
	maturity: string;
	role: string;
	version: number;
}): string {
	const raw = [
		parts.projectId ?? 0,
		parts.proposalId,
		parts.status,
		parts.maturity,
		parts.role,
		parts.version,
	].join(":");
	return createHash("sha256").update(raw).digest("hex");
}

/**
 * Hotfix: serialize postWorkOffer calls in-process so the in-flight cap
 * (ORCHESTRATOR_MAX_INFLIGHT_OFFERS) is actually enforced. Without this,
 * handleStateChange spawns N parallel
 * dispatchAgent calls; each does its own SELECT count(*) before INSERT and all
 * see the pre-INSERT inflight value, so cap=K admits N>K offers in one burst.
 * Live evidence 2026-05-29 03:23 UTC: cap=1 admitted 11 offers in a single tick.
 */
let postSerializationChain: Promise<unknown> = Promise.resolve();

/**
 * P1729: Check cumulative convergence guard. Returns { blockingCount, runsCount }
 * or throws ConvergenceGuardError if either exceeds its threshold.
 *
 * - blockingCount: proposal_reviews rows with is_blocking=true since state_changed_at
 * - runsCount: squad_dispatch rows for (proposal_id, agent_identity) since state_changed_at
 */
async function checkConvergenceGuard(
	proposalId: number,
	queryFn: QueryFn = defaultQuery,
): Promise<{ blockingCount: number; runsCount: number }> {
	// Fetch state_changed_at to define the window
	const { rows: stateRows } = await queryFn<{ state_changed_at: string }>(
		`SELECT state_changed_at::text
		   FROM roadmap_proposal.proposal
		  WHERE id = $1`,
		[proposalId],
	);
	const stateChangedAt = stateRows[0]?.state_changed_at;
	if (!stateChangedAt) {
		return { blockingCount: 0, runsCount: 0 };
	}

	// Count blocking reviews since last transition
	const { rows: blockingRows } = await queryFn<{ count: number }>(
		`SELECT count(*)::int AS count
		   FROM roadmap_proposal.proposal_reviews
		  WHERE proposal_id = $1
		    AND is_blocking = true
		    AND reviewed_at > $2::timestamp with time zone`,
		[proposalId, stateChangedAt],
	);
	const blockingCount = blockingRows[0]?.count ?? 0;

	// Count per-role run attempts since last transition
	const { rows: runsRows } = await queryFn<{ count: number }>(
		`SELECT count(*)::int AS count
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND agent_identity IS NOT NULL
		    AND assigned_at > $2::timestamp with time zone`,
		[proposalId, stateChangedAt],
	);
	const runsCount = runsRows[0]?.count ?? 0;

	// Check thresholds
	if (blockingCount >= GATE_CONVERGENCE_MAX_BLOCKING || runsCount >= GATE_CONVERGENCE_MAX_RUNS_PER_ROLE) {
		// Pause the proposal
		await queryFn(
			`UPDATE roadmap_proposal.proposal
			    SET gate_scanner_paused = true,
			        gate_paused_by = 'convergence_guard',
			        gate_paused_at = now(),
			        gate_paused_reason = $2
			  WHERE id = $1 AND gate_scanner_paused = false`,
			[
				proposalId,
				JSON.stringify({
					blocking_review_count: blockingCount,
					per_role_run_count: runsCount,
					threshold_blocking: GATE_CONVERGENCE_MAX_BLOCKING,
					threshold_runs_per_role: GATE_CONVERGENCE_MAX_RUNS_PER_ROLE,
					paused_reason: blockingCount >= GATE_CONVERGENCE_MAX_BLOCKING
						? `blocking reviews (${blockingCount} >= ${GATE_CONVERGENCE_MAX_BLOCKING})`
						: `per-role runs (${runsCount} >= ${GATE_CONVERGENCE_MAX_RUNS_PER_ROLE})`,
				}),
			],
		);

		// Emit notification
		await queryFn(
			`INSERT INTO roadmap.notification_queue
			   (proposal_id, severity, kind, title, body, metadata)
			 VALUES ($1, 'CRITICAL', 'convergence_guard_triggered', $2, $3, $4::jsonb)`,
			[
				proposalId,
				`Convergence guard triggered for proposal ${proposalId}`,
				`postWorkOffer refused: Proposal appears stuck — blocking reviews: ${blockingCount} (threshold ${GATE_CONVERGENCE_MAX_BLOCKING}), per-role runs: ${runsCount} (threshold ${GATE_CONVERGENCE_MAX_RUNS_PER_ROLE}) since last state/maturity transition. gate_scanner_paused=true. Investigate blocking feedback or stale acceptance criteria.`,
				JSON.stringify({
					proposal_id: proposalId,
					blocking_count: blockingCount,
					runs_count: runsCount,
					threshold_blocking: GATE_CONVERGENCE_MAX_BLOCKING,
					threshold_runs_per_role: GATE_CONVERGENCE_MAX_RUNS_PER_ROLE,
				}),
			],
		);

		throw new ConvergenceGuardError(
			proposalId,
			blockingCount >= GATE_CONVERGENCE_MAX_BLOCKING ? blockingCount : null,
			runsCount >= GATE_CONVERGENCE_MAX_RUNS_PER_ROLE ? runsCount : null,
			GATE_CONVERGENCE_MAX_BLOCKING,
			GATE_CONVERGENCE_MAX_RUNS_PER_ROLE,
		);
	}

	return { blockingCount, runsCount };
}

/**
 * Insert a work offer into squad_dispatch and notify the work_offers channel.
 * Any registered OfferProvider listening on that channel will race to claim it.
 *
 * Idempotent: concurrent callers with the same (project, proposal, status,
 * maturity, role, version) tuple either INSERT one row (the winner) or hit
 * ON CONFLICT and increment attempt_count. The returned dispatchId is the
 * canonical row in either case; `replay=true` flags the de-dup.
 */
export async function postWorkOffer(
	input: WorkOfferInput,
	queryFn: QueryFn = defaultQuery,
): Promise<WorkOfferResult> {
	const prev = postSerializationChain;
	let release: () => void = () => {};
	postSerializationChain = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		await prev.catch(() => {});
		return await postWorkOfferImpl(input, queryFn);
	} finally {
		release();
	}
}

async function postWorkOfferImpl(
	input: WorkOfferInput,
	queryFn: QueryFn = defaultQuery,
): Promise<WorkOfferResult> {
	// P908-D: generate a trace_id for this offer so claim/dispatch/completion
	// spans can be correlated across the pipeline without a shared in-memory map.
	const traceId = randomUUID();

	const metadata: Record<string, unknown> = { task: input.task, trace_id: traceId };
	if (input.stage) metadata.stage = input.stage;
	if (input.phase) metadata.phase = input.phase;
	if (input.model) metadata.model = input.model;
	if (input.timeoutMs) metadata.timeout_ms = input.timeoutMs;
	if (input.worktreeHint) metadata.worktree_hint = input.worktreeHint;
	if (input.briefingId) metadata.briefing_id = input.briefingId;
	if (input.roleProfileId != null) metadata.role_profile_id = input.roleProfileId;
	// P1292: Gate metadata for implicit-gate dispatch via offer lifecycle
	if (input.gateRole) metadata.gate_role = input.gateRole;
	if (input.gateFromStage) metadata.gate_from_stage = input.gateFromStage;
	if (input.gateToStage) metadata.gate_to_stage = input.gateToStage;
	if (input.gateRoleSource) metadata.gate_role_source = input.gateRoleSource;

	// P1290 follow-up: the legacy default '["general"]' was never seeded into
	// any agency's provider_registry.capabilities->'jobs', so offers posted
	// without explicit capabilities became permanently un-matchable and clogged
	// the global inflight cap. Default to ROLE_TO_REQUIRED_CAPABILITIES lookup
	// when the caller didn't supply caps; fall back to ["develop"] (the broadest
	// seeded cap, advertised by 9 of 19 dispatchable agencies).
	const caps = input.requiredCapabilities?.length
		? JSON.stringify(input.requiredCapabilities)
		: JSON.stringify(ROLE_TO_REQUIRED_CAPABILITIES[input.role.toLowerCase()] ?? ["develop"]);

	const dispatchVersion = input.dispatchVersion ?? 1;

	// P1291: Check for a non-expired pause row for this (proposal_id, role) tuple.
	// If found, throw PausedRoleError to skip posting. scanQueues catches this as
	// skip-and-continue, same as BackpressureError / DispatchLoopError.
	const { rows: pauseRows } = await queryFn<{
		pause_reason: string;
		expires_at: string;
	}>(
		`SELECT pause_reason, expires_at::text
		   FROM roadmap_workforce.proposal_role_pause
		  WHERE proposal_id = $1
		    AND role = $2
		    AND expires_at > now()
		  LIMIT 1`,
		[input.proposalId, input.role],
	);
	if (pauseRows.length > 0) {
		const pauseRow = pauseRows[0];
		const expiresAt = new Date(pauseRow.expires_at);
		throw new PausedRoleError(
			input.proposalId,
			input.role,
			pauseRow.pause_reason,
			expiresAt,
		);
	}

	// Backpressure: refuse new offers when the global in-flight queue is full.
	// Cheap pre-check — single COUNT against an indexed predicate. The cap is read
	// live (hot-reloadable) from ORCHESTRATOR_MAX_INFLIGHT_OFFERS; set to 0 so ops
	// can disable in emergencies — all via SQL, no restart.
	const maxGlobalInflightOffers = await resolveMaxGlobalInflightOffers();
	if (maxGlobalInflightOffers > 0) {
		const { rows: inflightRows } = await queryFn<{ count: number }>(
			`SELECT count(*)::int AS count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE offer_status IN ('open', 'claimed')
			    AND completed_at IS NULL`,
		);
		const inflight = inflightRows[0]?.count ?? 0;
		if (inflight >= maxGlobalInflightOffers) {
			throw new BackpressureError(inflight, maxGlobalInflightOffers);
		}
	}

	// Read current proposal state + project to compute the idempotency key.
	// Source from the base table (roadmap_proposal.proposal) because the
	// roadmap.proposal view doesn't expose project_id.
	const { rows: ctxRows } = await queryFn<{
		project_id: number | null;
		status: string | null;
		maturity: string | null;
		gate_scanner_paused: boolean;
		gate_paused_by: string | null;
		gate_paused_at: string | null;
	}>(
		// NOTE: proposal-pinned difficulty overrides (task_class/tier_override) are
		// NOT read here — they were SELECTed by P3310 (b63542cc) but the columns
		// were never migrated onto roadmap_proposal.proposal and the values were
		// never wired into the assessor (overrides flow via input.tierOverride /
		// input.taskClassOverride instead). The dead SELECT crashed every dispatch
		// with 42703 "column task_class does not exist" once the orchestrator
		// restarted onto this code. Removed. Re-add WITH a migration + ctx→input
		// wiring if proposal-level pinning is actually built.
		`SELECT project_id, status, maturity,
		        gate_scanner_paused, gate_paused_by,
		        gate_paused_at::text AS gate_paused_at
		 FROM roadmap_proposal.proposal
		 WHERE id = $1`,
		[input.proposalId],
	);
	const ctx = ctxRows[0];
	if (!ctx) {
		throw new Error(
			`postWorkOffer: proposal ${input.proposalId} not found`,
		);
	}

	// Terminal-status guard (operator directive): COMPLETE is terminal — refuse before INSERT.
	if (isTerminalProposalStatus(ctx.status)) {
		throw new TerminalProposalError(input.proposalId, ctx.status as string);
	}

	if (ctx.gate_scanner_paused) {
		throw new Error(
			`postWorkOffer: proposal ${input.proposalId} is gate_scanner_paused; dispatch refused`,
		);
	}

	// P1393: refuse dispatch when the proposal is paused. The state-poll
	// (orchestrator.ts:454) filters paused proposals, but scanQueues feeds
	// from v_mature_queue (which doesn't filter — see migration 180) and
	// legacy-dispatch's implicit-gate path also bypasses the flag. Without
	// this guard, paused proposals dispatch every tick and the circuit
	// breaker re-fires CRITICAL alerts on every cycle.
	if (ctx.gate_scanner_paused) {
		throw new ProposalPausedError(
			input.proposalId,
			ctx.gate_paused_by,
			ctx.gate_paused_at ? new Date(ctx.gate_paused_at) : null,
		);
	}

	// P3311: proactive premature-maturity guard. Fires BEFORE the reactive
	// breakers below so a no-implementation proposal never burns gate runs.
	// Condition: DEVELOP + mature + has ACs but ZERO passing. Demote to 'new'
	// (routes to a developer next scan) and refuse this gate offer.
	if (
		PREMATURE_GATE_GUARD_ENABLED &&
		ctx.status?.toUpperCase() === "DEVELOP" &&
		ctx.maturity?.toLowerCase() === "mature"
	) {
		const { rows: acRows } = await queryFn<{ total: number; passing: number }>(
			`SELECT count(*)::int AS total,
			        count(*) FILTER (WHERE status = 'pass')::int AS passing
			   FROM roadmap_proposal.proposal_acceptance_criteria
			  WHERE proposal_id = $1`,
			[input.proposalId],
		);
		const totalAcs = acRows[0]?.total ?? 0;
		const passingAcs = acRows[0]?.passing ?? 0;
		// Only act when there ARE ACs but none pass. Zero-AC proposals are a
		// separate concern (a gate review should flag the missing ACs) and
		// demoting them wouldn't help, so leave them to the gate.
		if (totalAcs > 0 && passingAcs === 0) {
			// Demote maturity → new so the next scan dispatches a developer
			// instead of the D3 gate. Idempotent (only flips a currently-mature
			// row); also clears any stale pause so the demoted proposal can flow.
			await queryFn(
				`UPDATE roadmap_proposal.proposal
				    SET maturity = 'new',
				        gate_scanner_paused = false,
				        gate_paused_by = NULL,
				        gate_paused_at = NULL
				  WHERE id = $1 AND maturity = 'mature' AND status = 'DEVELOP'`,
				[input.proposalId],
			);
			await queryFn(
				`INSERT INTO roadmap.notification_queue
				   (proposal_id, severity, kind, title, body, metadata)
				 VALUES ($1, 'INFO', 'premature_maturity_demoted', $2, $3, $4::jsonb)`,
				[
					input.proposalId,
					`Premature maturity demoted for proposal ${input.proposalId}`,
					`postWorkOffer refused a gate offer for role "${input.role}": proposal is DEVELOP/mature with 0/${totalAcs} passing acceptance criteria (no implementation evidence). Maturity demoted to 'new' to route to a developer. This pre-empts the D3 gate loop.`,
					JSON.stringify({
						proposal_id: input.proposalId,
						role: input.role,
						total_acs: totalAcs,
						passing_acs: passingAcs,
					}),
				],
			);
			throw new PrematureGateError(input.proposalId, input.role, totalAcs);
		}
	}

	// P1729: cumulative convergence guard. Check if blocking review count or
	// per-role run count have exceeded their thresholds since the last state/maturity
	// transition. If so, pause the proposal.
	try {
		await checkConvergenceGuard(input.proposalId, queryFn);
	} catch (err) {
		if (err instanceof ConvergenceGuardError) {
			throw err;
		}
		// Swallow other errors to avoid blocking dispatch on guard check failures
		obs.log({
			level: "warn",
			message: `convergence guard check failed for P${input.proposalId}`,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// P721: skip dispatch if the target route is currently throttled due to
	// a usage cap (e.g. Claude daily limit). This avoids consuming a
	// circuit-breaker slot on a route outage.
	if (input.model) {
		const { rows: throttleRows } = await queryFn<{ throttled_until: string }>(
			`SELECT throttled_until::text
			   FROM roadmap.host_model_route_throttle
			  WHERE model = $1
			    AND throttled_until > now()
			  LIMIT 1`,
			[input.model],
		);
		if (throttleRows.length > 0) {
			throw new Error(
				`postWorkOffer: route for model '${input.model}' is throttled until ${throttleRows[0].throttled_until}. Skipping dispatch.`,
			);
		}
	}

	// V3-C2 (P1434): cause-aware circuit breaker. squad_dispatch.failure_class is
	// the CANONICAL signal — the offer/dispatch row is the unit of routing, retry,
	// and failure policy; agent_runs is telemetry only and NEVER pauses a proposal
	// (decided in P1434 disc #8675, codex). This replaces the old two-source sum
	// (agent_runs + squad_dispatch) where auth-401 / spawn-SIGTERM agent_runs
	// failures and capacity/route outages all counted as "loops" and falsely
	// paused proposals (P238/P304/P194, 2026-05-27..29).
	//
	// Only genuine, unattributable post-delivery failures (failure_class='unknown',
	// non-transient) count toward the loop threshold. Transient causes —
	// auth_rejected, rate_limited, quota_exhausted, no_eligible_agency,
	// lease_expired — are stamped at their failure sites (fn_complete_work_offer
	// defaults 'unknown' but preserves a pre-stamped transient class;
	// fn_reap_expired_offers stamps lease_expired; offer-dispatch-handler stamps
	// auth/rate/quota) and are excluded here.
	const { rows: loopRows } = await queryFn<{ recent_runs: number }>(
		`SELECT count(*)::int AS recent_runs
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND dispatch_role = $2
		    AND dispatch_status = 'failed'
		    AND completed_at > now() - interval '1 hour'
		    AND failure_class = 'unknown'
		    AND failure_is_transient IS NOT TRUE`,
		[input.proposalId, input.role],
	);
	const recentRuns = loopRows[0]?.recent_runs ?? 0;
	if (recentRuns > DISPATCH_LOOP_THRESHOLD_PER_HOUR) {
		await queryFn(
			`UPDATE roadmap_proposal.proposal
			    SET gate_scanner_paused = true,
			        gate_paused_by = 'circuit_breaker',
			        gate_paused_at = now()
			  WHERE id = $1 AND gate_scanner_paused = false`,
			[input.proposalId],
		);
		await queryFn(
			`INSERT INTO roadmap.notification_queue
			   (proposal_id, severity, kind, title, body, metadata)
			 VALUES ($1, 'CRITICAL', 'dispatch_loop_detected', $2, $3, $4::jsonb)`,
			[
				input.proposalId,
				`Dispatch loop detected for proposal ${input.proposalId} (${input.role})`,
				`postWorkOffer refused: ${recentRuns} completed/failed runs for role "${input.role}" in last 1h (threshold ${DISPATCH_LOOP_THRESHOLD_PER_HOUR}). gate_scanner_paused=true. Investigate why the runs are not advancing state/maturity.`,
				JSON.stringify({
					proposal_id: input.proposalId,
					role: input.role,
					recent_runs: recentRuns,
					threshold: DISPATCH_LOOP_THRESHOLD_PER_HOUR,
					proposal_status: ctx.status,
					proposal_maturity: ctx.maturity,
				}),
			],
		);
		throw new DispatchLoopError(input.proposalId, input.role, recentRuns);
	}

	// P1289 AC-3 + P1290 AC-1: Pre-flight CAPABILITY check. Throw
	// CapabilityMismatchError (and INSERT nothing) only if NO registered agency is
	// CAPABLE of the required role — a durable capability gap, not a transient
	// availability state.
	//
	// P1438 AC-16 (C6 emergent availability): posting must NOT depend on
	// roadmap.agency.dispatchable / provider heartbeat / bridge liveness. The old
	// preflight also required `v_agency_status.dispatchable = true`, which is
	// heartbeat-derived — so a parked cold-wake liaison (the mandated V3 model)
	// would make the offer never post. Now we post the open-pool offer whenever a
	// capable agency EXISTS; availability is revealed later by a successful claim
	// (an asleep liaison simply doesn't claim, and the offer waits in the pool /
	// is reaped per policy). fn_claim_work_offer remains the atomic availability
	// truth and carries no presence prerequisite.
	// checkCaps falls back to ROLE_TO_REQUIRED_CAPABILITIES if the caller didn't
	// supply requiredCapabilities, so the preflight always has a value to check
	// against rather than silently skipping.
	const checkCaps = input.requiredCapabilities
		?? ROLE_TO_REQUIRED_CAPABILITIES[input.role.toLowerCase()]
		?? ["develop"];
	if (checkCaps.length > 0) {
		const { rows: agencyCountRows } = await queryFn<{ count: number }>(
			`SELECT count(*)::int AS count
			   FROM roadmap_workforce.provider_registry pr
			   JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			  WHERE pr.status NOT IN ('offline', 'retired')
			    AND ar.status = 'active'
			    AND ar.agent_type <> 'coordinator'
			    AND ar.agent_identity NOT LIKE 'test/%'
			    AND (pr.capabilities->'jobs') ?| $1::text[]`,
			[checkCaps],
		);
		if (agencyCountRows[0]?.count === 0) {
			throw new CapabilityMismatchError(
				input.proposalId,
				input.role,
				checkCaps,
			);
		}
	}

	// P3314: offer-dedup guard. The orchestrator re-posts the same (proposal, role)
	// every scan cycle (~15 min). Because the idempotency_key includes
	// dispatch_version, each re-post is a NEW row (the ON CONFLICT below only
	// matches an identical key), so the open pool fills with duplicate offers —
	// fatal under ORCHESTRATOR_MAX_INFLIGHT_OFFERS=1 (V3 phase-1). In the open-pool
	// model exactly one live offer per (proposal, role) is needed: whoever claims
	// it wins. Skip the INSERT (and the wake NOTIFY) when a live, non-expired offer
	// already exists; the existing offer stays in the pool for the AI liaison.
	const { rows: liveDup } = await queryFn<{ id: number }>(
		`SELECT id FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1 AND dispatch_role = $2
		    AND offer_status IN ('open', 'claimed', 'active')
		    AND (claim_expires_at IS NULL OR claim_expires_at > now())
		  ORDER BY id
		  LIMIT 1`,
		[input.proposalId, input.role],
	);
	if (liveDup[0]?.id) {
		// A live offer for this (proposal, role) already exists — skip the INSERT and
		// the wake NOTIFY; the existing offer stays in the pool for the AI liaison.
		return {
			dispatchId: liveDup[0].id,
			replay: false,
			attemptCount: 0,
			traceId,
			deduped: true,
		};
	}

	const idempotencyKey = computeIdempotencyKey({
		projectId: ctx.project_id,
		proposalId: input.proposalId,
		status: ctx.status ?? "unknown",
		maturity: ctx.maturity ?? "unknown",
		role: input.role,
		version: dispatchVersion,
	});

	// P3310 AC-1: run the deterministic difficulty assessor at mint time and
	// persist difficulty_score + required_capability_tier + task_class on the
	// squad_dispatch row. Signals: AC count (blast radius proxy) and prior
	// failed/expired dispatches for this (proposal, role) tuple (rework_count).
	// Best-effort: a signal-fetch failure must never block dispatch — fall back
	// to zeroed signals so the assessor still emits a (low) tier.
	let assessAcCount = 0;
	let assessReworkCount = 0;
	try {
		const { rows: sig } = await queryFn<{ ac_count: number; rework_count: number }>(
			`SELECT
			    (SELECT count(*)::int
			       FROM roadmap_proposal.proposal_acceptance_criteria
			      WHERE proposal_id = $1) AS ac_count,
			    (SELECT count(*)::int
			       FROM roadmap_workforce.squad_dispatch
			      WHERE proposal_id = $1
			        AND dispatch_role = $2
			        AND dispatch_status IN ('failed', 'cancelled', 'completed')) AS rework_count`,
			[input.proposalId, input.role],
		);
		assessAcCount = sig[0]?.ac_count ?? 0;
		assessReworkCount = sig[0]?.rework_count ?? 0;
	} catch {
		// swallow — assessment signals are advisory, not load-bearing for dispatch
	}

	const assessment = assessDifficulty({
		role: input.role,
		task: input.task,
		acCount: assessAcCount,
		reworkCount: assessReworkCount,
		tierOverride: input.tierOverride ?? null,
		taskClassOverride: isTaskClass(input.taskClassOverride)
			? input.taskClassOverride
			: null,
	});
	// Mirror into metadata for observability / trace correlation.
	metadata.difficulty_score = assessment.difficultyScore;
	metadata.required_capability_tier = assessment.requiredCapabilityTier;
	metadata.task_class = assessment.taskClass;

	const { rows } = await queryFn<{
		id: number;
		attempt_count: number;
		was_replay: boolean;
	}>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role, dispatch_status,
		    offer_status, agent_identity, required_capabilities, metadata,
		    workflow_state, idempotency_key, dispatch_version, attempt_count,
		    difficulty_score, required_capability_tier, task_class)
		 VALUES ($1, $2, $3, $4, 'open', 'open', NULL, $5::jsonb, $6::jsonb,
		         $7, $8, $9, 1,
		         $10::double precision, $11, $12)
		 ON CONFLICT (idempotency_key)
		   WHERE dispatch_status IN ('open', 'assigned', 'active')
		 DO UPDATE SET
		   attempt_count = squad_dispatch.attempt_count + 1,
		   difficulty_score = EXCLUDED.difficulty_score,
		   required_capability_tier = EXCLUDED.required_capability_tier,
		   task_class = COALESCE(EXCLUDED.task_class, squad_dispatch.task_class),
		   metadata = squad_dispatch.metadata
		            || jsonb_build_object(
		                 'last_replay_at', to_jsonb(now()),
		                 'replay_reason', 'idempotency_collision'
		               )
		 RETURNING id,
		           attempt_count,
		           (xmax::text::int <> 0) AS was_replay`,
		[
			input.proposalId,
			ctx.project_id ?? null,
			input.squadName,
			input.role,
			caps,
			JSON.stringify(metadata),
			ctx.status ?? null,
			idempotencyKey,
			dispatchVersion,
			assessment.difficultyScore,
			assessment.requiredCapabilityTier,
			assessment.taskClass,
		],
	);

	const row = rows[0];
	if (!row?.id) throw new Error("postWorkOffer: INSERT returned no id");
	const dispatchId = row.id;

	if (!row.was_replay) {
		await queryFn(`SELECT pg_notify('work_offers', $1)`, [
			JSON.stringify({
				event: "emitted",
				dispatch_id: dispatchId,
				proposal_id: input.proposalId,
				role: input.role,
			}),
		]);
	} else {
		await queryFn(`SELECT pg_notify('work_offers', $1)`, [
			JSON.stringify({
				event: "replay",
				dispatch_id: dispatchId,
				proposal_id: input.proposalId,
				role: input.role,
				attempt_count: row.attempt_count,
			}),
		]);
	}

	// P908-D: open+close offer_posted span so the trace records the dispatch event.
	// Best-effort — errors are swallowed inside ObservabilityWriter.
	if (!row.was_replay) {
		const span = await obs.startSpan({
			traceId,
			operation: "offer_posted",
			attributes: { dispatch_id: dispatchId, proposal_id: input.proposalId, role: input.role },
		});
		await obs.closeSpan({ spanId: span.spanId });
	}

	// AC-9 (P182): auto-charter team governance when 2+ dispatches are alive
	// for this proposal. Best-effort — chartering must never block dispatch.
	if (!row.was_replay) {
		try {
			await autoCharterIfNeeded(input.proposalId, queryFn);
		} catch {
			// swallow — chartering is advisory, not load-bearing
		}
	}

	return {
		dispatchId,
		replay: row.was_replay,
		attemptCount: row.attempt_count,
		traceId,
	};
}
