/**
 * P182 AC-9: Orchestrator auto-charter integration test.
 *
 * Verifies that when 2+ squad_dispatch rows exist for the same proposal_id
 * within a single dispatch cycle, a team:charter norm is automatically created
 * in team_norms for the resulting team.
 *
 * Run: bun test tests/integration/p182-auto-charter.test.ts
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { query, closePool } from "../../src/infra/postgres/pool.ts";
import { postWorkOffer } from "../../src/core/pipeline/post-work-offer.ts";
import { autoCharterIfNeeded } from "../../src/core/pipeline/auto-charter.ts";

const TEST_TAG = `itest_p182_${Math.random().toString(36).slice(2, 10)}`;

describe("P182 AC-9: Orchestrator auto-charter hook", () => {
	let testProposalId: number;
	let testDisplayId: string;
	let teamName: string;

	before(async () => {
		testDisplayId = `P_${TEST_TAG}`.slice(0, 16);
		teamName = `team:${testDisplayId}-dispatch-auto`;
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, summary, type, status, maturity, project_id, audit)
			 VALUES ($1, $2, $3, 'feature', 'DEVELOP', 'mature', 1, '[]'::jsonb)
			 RETURNING id`,
			[
				testDisplayId,
				`p182-autochartertest ${TEST_TAG}`,
				"P182 AC-9 auto-charter integration test fixture",
			],
		);
		testProposalId = rows[0].id;
	});

	after(async () => {
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`,
			[testProposalId],
		);
		await query(
			`DELETE FROM roadmap_workforce.team WHERE team_name = $1`,
			[teamName],
		);
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [
			testProposalId,
		]);
		await closePool();
	});

	it("does not create a charter after a single dispatch", async () => {
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}-a`,
			role: `role-developer-${TEST_TAG}`,
			task: "first agent dispatch",
		});

		const { rows } = await query<{ cnt: number }>(
			`SELECT count(*)::int AS cnt
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key = 'team:charter'`,
			[teamName],
		);
		assert.equal(rows[0].cnt, 0, "No charter should exist after single dispatch");
	});

	it("creates team:charter in team_norms when 2+ dispatches exist for the same proposal", async () => {
		// Second dispatch with a different role — now 2 alive rows exist for the same proposal
		await postWorkOffer({
			proposalId: testProposalId,
			squadName: `sq-${TEST_TAG}-b`,
			role: `role-reviewer-${TEST_TAG}`,
			task: "second agent dispatch",
		});

		const { rows } = await query<{ norm_value: Record<string, unknown> }>(
			`SELECT tn.norm_value
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			    AND tn.norm_key = 'team:charter'`,
			[teamName],
		);

		assert.equal(rows.length, 1, "team:charter norm must exist after 2nd dispatch");
		const charter = rows[0].norm_value;
		assert.equal(charter.governance_layer, "team");
		assert.equal(charter.created_by, "orchestrator:auto-charter");
		assert.ok(
			Array.isArray(charter.proposal_ids) &&
				charter.proposal_ids.includes(String(testProposalId)),
			`charter.proposal_ids must include ${testProposalId}`,
		);
		assert.ok(
			Array.isArray(charter.norms_applied) &&
				(charter.norms_applied as string[]).length === 5,
			"charter must list 5 default norms",
		);
	});

	it("creates default governance norms alongside the charter", async () => {
		const { rows } = await query<{ norm_key: string }>(
			`SELECT tn.norm_key
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1
			  ORDER BY tn.norm_key`,
			[teamName],
		);
		const keys = rows.map((r) => r.norm_key);
		const expected = [
			"team:charter",
			"team:norm:challenge",
			"team:norm:communication",
			"team:norm:handoff",
			"team:norm:memory",
			"team:norm:worktree",
		];
		for (const k of expected) {
			assert.ok(keys.includes(k), `Missing norm: ${k}`);
		}
	});

	it("is idempotent — calling autoCharterIfNeeded again does not duplicate norms", async () => {
		await autoCharterIfNeeded(testProposalId);

		const { rows } = await query<{ cnt: number }>(
			`SELECT count(*)::int AS cnt
			   FROM roadmap_workforce.team_norms tn
			   JOIN roadmap_workforce.team t ON t.id = tn.team_id
			  WHERE t.team_name = $1`,
			[teamName],
		);
		// 1 charter + 5 default norms = 6 total; idempotent re-call must not add dupes
		assert.equal(
			rows[0].cnt,
			6,
			"Idempotent call must not add duplicate norms (expected 6 total)",
		);
	});
});
