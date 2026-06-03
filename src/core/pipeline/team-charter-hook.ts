/**
 * AC-9 (P182): Auto-charter hook — creates a team and team:charter norm in
 * team_norms when 2+ squad_dispatch rows are active for the same proposal.
 *
 * Called by postWorkOffer after a successful INSERT so every multi-agent
 * dispatch gets a governance record without requiring orchestrator-level
 * awareness of team state.
 */

import type { QueryFn } from "./post-work-offer.ts";

const TEAM_DEFAULT_NORMS: Record<string, Record<string, string>> = {
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
 * Idempotent: safe to call on every squad_dispatch INSERT.
 * Does nothing when fewer than 2 active rows exist for the proposal.
 * When threshold is met, finds or creates the team row and upserts
 * the team:charter + 5 default norms.
 */
export async function maybeCharterTeam(
	proposalId: number,
	queryFn: QueryFn,
): Promise<void> {
	// Only charter when 2+ agents are dispatched to the same proposal
	const { rows: countRows } = await queryFn<{ cnt: number }>(
		`SELECT count(*)::int AS cnt
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND dispatch_status IN ('open', 'assigned', 'active')`,
		[proposalId],
	);
	if ((countRows[0]?.cnt ?? 0) < 2) return;

	// Find or create a team for this proposal. The CTE handles the race:
	// if two concurrent callers both try to INSERT, one wins; both get the id.
	const teamName = `team-P${proposalId}`;
	const { rows: teamRows } = await queryFn<{ id: number }>(
		`WITH ins AS (
		   INSERT INTO roadmap_workforce.team
		     (team_name, team_type, status, metadata)
		   VALUES ($1, 'proposal', 'active', jsonb_build_object('proposal_id', $2::text))
		   ON CONFLICT (team_name) DO NOTHING
		   RETURNING id
		 )
		 SELECT id FROM ins
		 UNION ALL
		 SELECT id FROM roadmap_workforce.team WHERE team_name = $1
		 LIMIT 1`,
		[teamName, String(proposalId)],
	);

	const teamId = teamRows[0]?.id;
	if (!teamId) return; // should not happen

	// Upsert the charter (always refresh so proposal_ids stays current)
	const charterValue = {
		team_name: teamName,
		proposal_ids: [String(proposalId)],
		created_by: "orchestrator",
		governance_layer: "team",
		norms_applied: Object.keys(TEAM_DEFAULT_NORMS),
		custom_norms: {},
	};

	await queryFn(
		`INSERT INTO roadmap_workforce.team_norms
		   (team_id, norm_key, norm_value, set_by)
		 VALUES ($1, 'team:charter', $2, 'orchestrator')
		 ON CONFLICT (team_id, norm_key)
		 DO UPDATE SET norm_value = EXCLUDED.norm_value,
		               updated_at = now()`,
		[teamId, JSON.stringify(charterValue)],
	);

	// Insert default norms — skip silently if already present
	for (const [normKey, normVal] of Object.entries(TEAM_DEFAULT_NORMS)) {
		await queryFn(
			`INSERT INTO roadmap_workforce.team_norms
			   (team_id, norm_key, norm_value, set_by)
			 VALUES ($1, $2, $3, 'orchestrator')
			 ON CONFLICT (team_id, norm_key) DO NOTHING`,
			[teamId, normKey, JSON.stringify(normVal)],
		);
	}
}
