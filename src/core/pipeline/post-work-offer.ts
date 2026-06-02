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

import { createHash } from "node:crypto";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

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
}

export interface WorkOfferResult {
	dispatchId: number;
	/** True when the INSERT collided with an existing alive dispatch row. */
	replay: boolean;
	/** Total number of times this idempotency_key has been posted. */
	attemptCount: number;
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
	const metadata: Record<string, unknown> = { task: input.task };
	if (input.stage) metadata.stage = input.stage;
	if (input.phase) metadata.phase = input.phase;
	if (input.model) metadata.model = input.model;
	if (input.timeoutMs) metadata.timeout_ms = input.timeoutMs;
	if (input.worktreeHint) metadata.worktree_hint = input.worktreeHint;
	if (input.briefingId) metadata.briefing_id = input.briefingId;

	const caps = input.requiredCapabilities?.length
		? JSON.stringify(input.requiredCapabilities)
		: '["general"]';

	const dispatchVersion = input.dispatchVersion ?? 1;

	// Read current proposal state + project to compute the idempotency key.
	// Source from the base table (roadmap_proposal.proposal) because the
	// roadmap.proposal view doesn't expose project_id.
	const { rows: ctxRows } = await queryFn<{
		project_id: number | null;
		status: string | null;
		maturity: string | null;
	}>(
		`SELECT project_id, status, maturity
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
	const { rows: loopRows } = await queryFn<{ recent_runs: number }>(
		`SELECT count(*)::int AS recent_runs
		   FROM roadmap_workforce.agent_runs
		  WHERE proposal_id = $1
		    AND status IN ('completed', 'failed')
		    AND COALESCE(completed_at, started_at) > now() - interval '1 hour'
		    AND (
		      stage = $2
		      OR stage = upper($2)
		      OR stage = 'gate:' || $2
		      OR agent_identity LIKE '%' || $2 || '%'
		    )`,
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

	// AC-9 (P182): when a fresh dispatch brings the alive count for this
	// proposal to 2+, ensure a team charter exists so team governance applies.
	if (!row.was_replay) {
		await autoCharterIfNeeded(input.proposalId, queryFn);
	}

	return {
		dispatchId,
		replay: row.was_replay,
		attemptCount: row.attempt_count,
	};
}

/**
 * P182 AC-9: Create a team charter in roadmap_workforce.team_norms when a
 * proposal has 2 or more alive squad_dispatch rows.  Idempotent — safe to
 * call on every fresh dispatch; does nothing when < 2 alive rows exist, and
 * the team:charter INSERT uses ON CONFLICT DO NOTHING.
 */
async function autoCharterIfNeeded(
	proposalId: number,
	queryFn: QueryFn,
): Promise<void> {
	const { rows: countRows } = await queryFn<{ alive: number }>(
		`SELECT count(*)::int AS alive
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND dispatch_status IN ('open', 'assigned', 'active')`,
		[proposalId],
	);
	if ((countRows[0]?.alive ?? 0) < 2) return;

	const teamName = `team:proposal:${proposalId}`;

	// Upsert team row; ON CONFLICT touches metadata so RETURNING always fires.
	const { rows: teamRows } = await queryFn<{ id: number }>(
		`INSERT INTO roadmap_workforce.team
		   (team_name, team_type, status, metadata)
		 VALUES ($1, 'proposal', 'active', $2::jsonb)
		 ON CONFLICT (team_name)
		 DO UPDATE SET metadata = roadmap_workforce.team.metadata
		 RETURNING id`,
		[
			teamName,
			JSON.stringify({ auto_chartered: true, proposal_id: proposalId }),
		],
	);
	const teamId = teamRows[0]?.id;
	if (!teamId) return;

	// Charter norm — idempotent, skip if already present.
	await queryFn(
		`INSERT INTO roadmap_workforce.team_norms
		   (team_id, norm_key, norm_value, set_by)
		 VALUES ($1, 'team:charter', $2::jsonb, 'orchestrator')
		 ON CONFLICT (team_id, norm_key) DO NOTHING`,
		[
			teamId,
			JSON.stringify({
				team_name: teamName,
				proposal_ids: [String(proposalId)],
				created_by: "orchestrator",
				governance_layer: "team",
				auto_chartered: true,
			}),
		],
	);

	// Five default norms — idempotent.
	const DEFAULT_NORMS: [string, Record<string, string>][] = [
		["team:norm:handoff", { rule: "Leave context summary in team memory before releasing lease" }],
		["team:norm:communication", { rule: "Use team: prefix in proposal_discussions for intra-team matters" }],
		["team:norm:challenge", { rule: "Skeptic challenges go through team discussion before gate" }],
		["team:norm:memory", { rule: "Design decisions in team memory; implementation notes in individual" }],
		["team:norm:worktree", { rule: "Coordinate via proposal_discussions before merging branches" }],
	];
	for (const [normKey, normVal] of DEFAULT_NORMS) {
		await queryFn(
			`INSERT INTO roadmap_workforce.team_norms
			   (team_id, norm_key, norm_value, set_by)
			 VALUES ($1, $2, $3::jsonb, 'orchestrator')
			 ON CONFLICT (team_id, norm_key) DO NOTHING`,
			[teamId, normKey, JSON.stringify(normVal)],
		);
	}
}
