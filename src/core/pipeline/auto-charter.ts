/**
 * AC-9 (P182): Auto-charter team governance when 2+ alive dispatches exist
 * for the same proposal within a single dispatch cycle.
 *
 * Called by postWorkOffer after every non-replay INSERT. Best-effort — callers
 * must swallow errors so chartering never blocks dispatch.
 */

import type { QueryFn } from "./post-work-offer.ts";

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
 * If 2+ alive squad_dispatch rows exist for proposalId, find-or-create a
 * team row and upsert team:charter + 5 default norms into team_norms.
 * Idempotent and concurrent-safe via ON CONFLICT upserts.
 */
export async function autoCharterIfNeeded(
	proposalId: number,
	queryFn: QueryFn,
): Promise<void> {
	const { rows: countRows } = await queryFn<{ alive_count: number }>(
		`SELECT count(*)::int AS alive_count
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND offer_status IN ('open', 'claimed', 'active')
		    AND completed_at IS NULL`,
		[proposalId],
	);

	const aliveCount = countRows[0]?.alive_count ?? 0;
	if (aliveCount < 2) return;

	const teamName = `P${proposalId}-squad`;
	const metadata = JSON.stringify({
		proposal_id: proposalId,
		auto_chartered: true,
		chartered_at: new Date().toISOString(),
	});

	// Find-or-create: ON CONFLICT (team_name) DO UPDATE with a no-op ensures
	// RETURNING id is populated whether we inserted or hit an existing row.
	const { rows: teamRows } = await queryFn<{ id: number }>(
		`INSERT INTO roadmap_workforce.team
		   (team_name, team_type, status, metadata)
		 VALUES ($1, 'proposal', 'active', $2::jsonb)
		 ON CONFLICT (team_name) DO UPDATE
		   SET team_name = EXCLUDED.team_name
		 RETURNING id`,
		[teamName, metadata],
	);

	const teamId = teamRows[0]?.id;
	if (!teamId) return;

	const charterValue = JSON.stringify({
		proposal_id: proposalId,
		created_by: "orchestrator",
		governance_layer: "team",
		norms_applied: Object.keys(DEFAULT_NORMS),
	});

	await queryFn(
		`INSERT INTO roadmap_workforce.team_norms
		   (team_id, norm_key, norm_value, set_by)
		 VALUES ($1, 'team:charter', $2, 'orchestrator')
		 ON CONFLICT (team_id, norm_key)
		 DO UPDATE SET norm_value = EXCLUDED.norm_value,
		               set_by = EXCLUDED.set_by,
		               updated_at = now()`,
		[teamId, charterValue],
	);

	for (const [normKey, normVal] of Object.entries(DEFAULT_NORMS)) {
		await queryFn(
			`INSERT INTO roadmap_workforce.team_norms
			   (team_id, norm_key, norm_value, set_by)
			 VALUES ($1, $2, $3, 'orchestrator')
			 ON CONFLICT (team_id, norm_key) DO NOTHING`,
			[teamId, normKey, JSON.stringify(normVal)],
		);
	}
}
