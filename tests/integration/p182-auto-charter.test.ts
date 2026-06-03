/**
 * P182 AC-9: Auto-charter integration test.
 *
 * Seeds 2 squad_dispatch rows for the same proposal_id via postWorkOffer()
 * and confirms a team:charter norm was created in team_norms.
 *
 * Requires a reachable Postgres with migrations applied.
 * Run: bun test tests/integration/p182-auto-charter.test.ts
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { query, closePool } from "../../src/infra/postgres/pool.ts";
import { postWorkOffer } from "../../src/core/pipeline/post-work-offer.ts";

const TEST_TAG = `p182_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

describe("P182 AC-9: auto-charter on multi-agent dispatch", () => {
	let testProposalId: number;
	let teamName: string;

	beforeEach(async () => {
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, summary, type, status, maturity, project_id, audit)
			 VALUES ($1, $2, $3, 'feature', 'DEVELOP', 'active', 1, '[]'::jsonb)
			 RETURNING id`,
			[
				`P_${TEST_TAG}`.slice(0, 16),
				`p182-auto-charter ${TEST_TAG}`,
				"P182 AC-9 test fixture",
			],
		);
		testProposalId = rows[0].id;
		teamName = `team-P${testProposalId}`;
	});

	afterEach(async () => {
		const { rows: teamRows } = await query<{ id: number }>(
			`SELECT id FROM roadmap_workforce.team WHERE team_name = $1`,
			[teamName],
		);
		if (teamRows.length > 0) {
			await query(
				`DELETE FROM roadmap_workforce.team_norms WHERE team_id = $1`,
				[teamRows[0].id],
			);
			await query(
				`DELETE FROM roadmap_workforce.team WHERE id = $1`,
				[teamRows[0].id],
			);
		}
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`,
			[testProposalId],
		);
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [
			testProposalId,
		]);
	});

	it("single dispatch does not create a charter", async () => {
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}`,
			role: `architect`,
			task: "first dispatch — no charter expected",
		});

		const { rows } = await query<{ count: string }>(
			`SELECT count(*)::text AS count
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key = 'team:charter'`,
			[teamName],
		);
		assert.equal(rows[0].count, "0", "no charter after a single dispatch");
	});

	it("second dispatch creates team:charter in team_norms", async () => {
		// Post two offers with different roles → two distinct alive rows.
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}`,
			role: "architect",
			task: "first dispatch",
		});
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}`,
			role: "engineer",
			task: "second dispatch — triggers auto-charter",
		});

		const { rows } = await query<{
			norm_key: string;
			set_by: string;
			team_name: string;
		}>(
			`SELECT tn.norm_key, tn.set_by, t.team_name
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key = 'team:charter'`,
			[teamName],
		);

		assert.equal(rows.length, 1, "exactly one team:charter norm must exist");
		assert.equal(rows[0].norm_key, "team:charter");
		assert.equal(rows[0].set_by, "orchestrator");
		assert.equal(rows[0].team_name, teamName);
	});

	it("auto-charter seeds all five default norms", async () => {
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}`,
			role: "architect",
			task: "first dispatch",
		});
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}`,
			role: "engineer",
			task: "second dispatch",
		});

		const { rows } = await query<{ norm_key: string }>(
			`SELECT tn.norm_key
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key LIKE 'team:norm:%'`,
			[teamName],
		);

		const found = rows.map((r) => r.norm_key).sort();
		const expected = [
			"team:norm:challenge",
			"team:norm:communication",
			"team:norm:handoff",
			"team:norm:memory",
			"team:norm:worktree",
		];
		assert.deepEqual(found, expected, "all 5 default norms must be seeded");
	});

	it("repeated dispatches do not duplicate the charter (idempotent)", async () => {
		for (const role of ["architect", "engineer", "reviewer"]) {
			await postWorkOffer({
				proposalId: testProposalId,
				squadName: `sq-${TEST_TAG}`,
				role,
				task: `dispatch for ${role}`,
			});
		}

		const { rows } = await query<{ count: string }>(
			`SELECT count(*)::text AS count
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key = 'team:charter'`,
			[teamName],
		);
		assert.equal(rows[0].count, "1", "charter must remain exactly one row after repeated dispatches");
	});
});
