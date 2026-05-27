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
import { ObservabilityWriter } from "../observability/observability-writer.ts";
import { ROLE_TO_REQUIRED_CAPABILITIES } from "../orchestration/offer-dispatch.ts";

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
 * Global cap on alive offers (open or claimed-but-not-completed) across the
 * whole orchestrator. The orchestrator otherwise tends to fan out 80–100 offers
 * in seconds, exhausting agency capacity and starting Claude subprocesses that
 * can't all complete before the next tick — burning budget on offers no one can
 * service. With a cap, postWorkOffer becomes backpressure-aware: once the
 * queue is full, new posts are rejected until existing offers complete via
 * fn_complete_work_offer or fn_reap_expired_offers reissues stale leases.
 *
 * Override via AGENTHIVE_MAX_INFLIGHT_OFFERS env. Set to 0 to disable.
 */
const MAX_GLOBAL_INFLIGHT_OFFERS = Number(
	process.env.AGENTHIVE_MAX_INFLIGHT_OFFERS ?? "20",
);

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
}

export interface WorkOfferResult {
	dispatchId: number;
	/** True when the INSERT collided with an existing alive dispatch row. */
	replay: boolean;
	/** Total number of times this idempotency_key has been posted. */
	attemptCount: number;
	/** P908-D: UUID threaded through the offer pipeline for observability trace correlation. */
	traceId: string;
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
	// Cheap pre-check — single COUNT against an indexed predicate. Skipped when
	// AGENTHIVE_MAX_INFLIGHT_OFFERS=0 so ops can disable in emergencies.
	if (MAX_GLOBAL_INFLIGHT_OFFERS > 0) {
		const { rows: inflightRows } = await queryFn<{ count: number }>(
			`SELECT count(*)::int AS count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE offer_status IN ('open', 'claimed')
			    AND completed_at IS NULL`,
		);
		const inflight = inflightRows[0]?.count ?? 0;
		if (inflight >= MAX_GLOBAL_INFLIGHT_OFFERS) {
			throw new BackpressureError(inflight, MAX_GLOBAL_INFLIGHT_OFFERS);
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

	// P689 circuit breaker: bail before posting if (proposal, role) is in a
	// completed-run loop. agent_runs.stage carries the role under several
	// historical aliases (uppercase stage name, role string, "gate:STAGE"),
	// so accept any match.
	// P721: exclude 'rate_limited' — those are route outages, not loops.
	// P1289: also count squad_dispatch failures (dispatch-level loops) where
	// no agent_run was ever created (e.g. no eligible agency found).
	// P1393: also exclude squad_dispatch rows tagged with
	// metadata.failure_reason='rate_limited'. offer-dispatch-handler.ts stamps
	// this when the agent_run came back rate_limited — the handler's status
	// union is delivered|failed, so without the marker the squad_dispatch row
	// would falsely look like a loop failure.
	const { rows: loopRows } = await queryFn<{ recent_runs: number }>(
		`SELECT (
		   SELECT count(*)::int
		     FROM roadmap_workforce.agent_runs
		    WHERE proposal_id = $1
		      AND status IN ('completed', 'failed')
		      AND COALESCE(completed_at, started_at) > now() - interval '1 hour'
		      AND (
		        stage = $2
		        OR stage = upper($2)
		        OR stage = 'gate:' || $2
		        OR agent_identity LIKE '%' || $2 || '%'
		      )
		 ) + (
		   SELECT count(*)::int
		     FROM roadmap_workforce.squad_dispatch
		    WHERE proposal_id = $1
		      AND dispatch_role = $2
		      AND dispatch_status = 'failed'
		      AND completed_at > now() - interval '1 hour'
		      AND COALESCE(metadata->>'failure_reason', '') <> 'rate_limited'
		 ) AS recent_runs`,
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

	// P1289 AC-3 + P1290 AC-1: Pre-flight dispatchability check. Throw
	// CapabilityMismatchError (and INSERT nothing) if no active agency advertises
	// the required capabilities. Mirrors the full resolveAgency predicate at
	// agency-resolver.ts:130 — provider_registry.capabilities->'jobs' AND
	// v_agency_status.dispatchable (which a2a-host's fn_pulse keeps fresh via
	// roadmap.agency.presence_state). Checking provider_registry.status alone
	// was stricter than the matcher and rejected offers the matcher would have
	// claimed when only the new generic a2a-host (P1132) is running and no
	// per-agency service updates provider_registry.status.
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
			   LEFT JOIN roadmap.v_agency_status vas ON vas.agency_id = ar.agent_identity
			  WHERE pr.status NOT IN ('offline', 'retired')
			    AND ar.status = 'active'
			    AND ar.agent_type <> 'coordinator'
			    AND ar.agent_identity NOT LIKE 'test/%'
			    AND (vas.agency_id IS NULL OR vas.dispatchable = true)
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

	const idempotencyKey = computeIdempotencyKey({
		projectId: ctx.project_id,
		proposalId: input.proposalId,
		status: ctx.status ?? "unknown",
		maturity: ctx.maturity ?? "unknown",
		role: input.role,
		version: dispatchVersion,
	});

	const { rows } = await queryFn<{
		id: number;
		attempt_count: number;
		was_replay: boolean;
	}>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, squad_name, dispatch_role, dispatch_status,
		    offer_status, agent_identity, required_capabilities, metadata,
		    idempotency_key, dispatch_version, attempt_count)
		 VALUES ($1, $2, $3, 'open', 'open', NULL, $4::jsonb, $5::jsonb,
		         $6, $7, 1)
		 ON CONFLICT (idempotency_key)
		   WHERE dispatch_status IN ('open', 'assigned', 'active')
		 DO UPDATE SET
		   attempt_count = squad_dispatch.attempt_count + 1,
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
			input.squadName,
			input.role,
			caps,
			JSON.stringify(metadata),
			idempotencyKey,
			dispatchVersion,
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

	return {
		dispatchId,
		replay: row.was_replay,
		attemptCount: row.attempt_count,
		traceId,
	};
}
