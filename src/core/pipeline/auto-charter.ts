/**
 * P182 AC-9: autoCharterIfNeeded — automatic team charter creation on multi-agent dispatch.
 *
 * Called by postWorkOffer after every non-replay INSERT into squad_dispatch.
 * When 2+ alive offers exist for the same proposal_id, finds-or-creates a team
 * row and upserts the charter + 5 default governance norms into team_norms.
 *
 * Idempotent: subsequent calls with an existing charter are cheap no-ops.
 * Fail-safe: the caller (postWorkOffer) wraps this in try/catch so charter
 * failures never block the primary offer pipeline.
 */

import type { QueryFn } from "./post-work-offer.ts";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

const DEFAULT_NORMS: Record<string, Record<string, string>> = {
	"team:norm:handoff": {
		rule: "Leave context summary in team memory before releasing lease",
		key: "team:handoff",
	},
	"team:norm:communication": {
		rule: "Use team: prefix in proposal_discussions for intra-team matters",
		key: "team:communication",
	},
	"team:norm:challenge": {
		rule: "Skeptic challenges go through team discussion before gate",
		key: "team:challenge",
	},
	"team:norm:memory": {
		rule: "Design decisions in team memory; implementation notes in individual",
		key: "team:memory",
	},
	"team:norm:worktree": {
		rule: "Coordinate via proposal_discussions before merging branches",
		key: "team:worktree",
	},
};

export interface AutoCharterResult {
	/** True when a new charter was written this call. False = already existed or too few dispatches. */
	chartered: boolean;
	teamId?: number;
}

/**
 * If ≥ 2 alive squad_dispatch rows exist for proposalId, find-or-create a team
 * and upsert the team:charter + 5 default norms. Returns whether a new charter
 * was written.
 */
export async function autoCharterIfNeeded(
	proposalId: number,
	queryFn: QueryFn = defaultQuery,
): Promise<AutoCharterResult> {
	const { rows: aliveRows } = await queryFn<{ count: number }>(
		`SELECT count(*)::int AS count
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND offer_status IN ('open', 'claimed', 'active')
		    AND completed_at IS NULL`,
		[proposalId],
	);

	const aliveCount = aliveRows[0]?.count ?? 0;
	if (aliveCount < 2) {
		return { chartered: false };
	}

	// Find an existing active team for this proposal.
	const { rows: existingTeamRows } = await queryFn<{ id: number }>(
		`SELECT id
		   FROM roadmap_workforce.team
		  WHERE metadata->>'proposal_id' = $1::text
		    AND status = 'active'
		  LIMIT 1`,
		[String(proposalId)],
	);

	let teamId: number;

	if (existingTeamRows.length > 0) {
		teamId = existingTeamRows[0].id;
	} else {
		const { rows: newTeamRows } = await queryFn<{ id: number }>(
			`INSERT INTO roadmap_workforce.team
			   (team_name, team_type, status, metadata)
			 VALUES ($1, 'proposal', 'active', $2::jsonb)
			 RETURNING id`,
			[
				`P${proposalId}-team`,
				JSON.stringify({ proposal_id: proposalId, auto_chartered: true }),
			],
		);
		teamId = newTeamRows[0].id;
	}

	// No-op if charter already exists.
	const { rows: existingCharterRows } = await queryFn<{ id: number }>(
		`SELECT id
		   FROM roadmap_workforce.team_norms
		  WHERE team_id = $1
		    AND norm_key = $2
		  LIMIT 1`,
		[teamId, "team:charter"],
	);

	if (existingCharterRows.length > 0) {
		return { chartered: false, teamId };
	}

	const charterValue = {
		team_name: `P${proposalId}-team`,
		proposal_ids: [String(proposalId)],
		created_by: "orchestrator:auto-charter",
		governance_layer: "team",
		norms_applied: Object.keys(DEFAULT_NORMS),
		auto_chartered: true,
	};

	await queryFn(
		`INSERT INTO roadmap_workforce.team_norms
		   (team_id, norm_key, norm_value, set_by)
		 VALUES ($1, $2, $3, 'orchestrator:auto-charter')
		 ON CONFLICT (team_id, norm_key) DO UPDATE
		   SET norm_value = EXCLUDED.norm_value,
		       set_by = EXCLUDED.set_by,
		       updated_at = now()`,
		[teamId, "team:charter", JSON.stringify(charterValue)],
	);

	for (const [normKey, normVal] of Object.entries(DEFAULT_NORMS)) {
		await queryFn(
			`INSERT INTO roadmap_workforce.team_norms
			   (team_id, norm_key, norm_value, set_by)
			 VALUES ($1, $2, $3, 'orchestrator:auto-charter')
			 ON CONFLICT (team_id, norm_key) DO NOTHING`,
			[teamId, normKey, JSON.stringify(normVal)],
		);
	}

	return { chartered: true, teamId };
}
