/**
 * P182 AC-9: Auto-charter hook for team governance.
 *
 * Called after each non-replay squad_dispatch INSERT. When 2+ alive dispatches
 * exist for the same proposal_id, finds-or-creates a team record and writes a
 * team:charter + default governance norms into team_norms. Safe to call on
 * every non-replay INSERT — the count guard and ON CONFLICT upserts make it
 * idempotent.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

type QueryFn = typeof defaultQuery;

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

/**
 * Check if 2+ alive squad_dispatch rows exist for proposalId; if so, ensure
 * the proposal team has a team:charter entry in team_norms.
 */
export async function autoCharterIfNeeded(
	proposalId: number,
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	const { rows: countRows } = await queryFn<{ cnt: number }>(
		`SELECT count(*)::int AS cnt
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND dispatch_status IN ('open', 'assigned', 'active')`,
		[proposalId],
	);
	const aliveCount = countRows[0]?.cnt ?? 0;
	if (aliveCount < 2) return;

	const { rows: propRows } = await queryFn<{
		display_id: string;
		title: string;
	}>(
		`SELECT display_id, title FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	if (propRows.length === 0) return;
	const { display_id: displayId, title } = propRows[0];

	const teamName = `team:${displayId}-dispatch-auto`;

	const { rows: teamRows } = await queryFn<{ id: number }>(
		`INSERT INTO roadmap_workforce.team
		   (team_name, team_type, status, metadata)
		 VALUES ($1, 'proposal', 'active', '{}')
		 ON CONFLICT (team_name) DO UPDATE SET status = EXCLUDED.status
		 RETURNING id`,
		[teamName],
	);
	const teamId = teamRows[0]?.id;
	if (!teamId) return;

	const charterValue = JSON.stringify({
		team_name: teamName,
		proposal_ids: [String(proposalId)],
		created_by: "orchestrator:auto-charter",
		governance_layer: "team",
		norms_applied: Object.keys(DEFAULT_NORMS),
		title,
	});

	await queryFn(
		`INSERT INTO roadmap_workforce.team_norms
		   (team_id, norm_key, norm_value, set_by)
		 VALUES ($1, 'team:charter', $2, 'orchestrator:auto-charter')
		 ON CONFLICT (team_id, norm_key)
		 DO UPDATE SET norm_value = EXCLUDED.norm_value, updated_at = now()`,
		[teamId, charterValue],
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
}
