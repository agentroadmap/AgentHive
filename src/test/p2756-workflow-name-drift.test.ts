/**
 * P2756: Workflow-name drift — write-side guard
 *
 * AC-6: For every type in proposal_type_config, a freshly created proposal
 *       has proposal.workflow_name == workflow_templates.name of its seeded
 *       workflows row. (Creation-path regression test.)
 *
 * AC-7: CI audit — no non-terminal proposal has workflow_name <> its
 *       workflows-table template name. Excludes P3326-arch- and P3326-test- prefixed
 *       test fixtures.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { getPool, query } from "../infra/postgres/pool";

const CREATED_IDS: number[] = [];

afterEach(async () => {
	if (CREATED_IDS.length > 0) {
		const pool = getPool();
		await pool.query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = ANY($1::int[])`,
			[CREATED_IDS],
		);
		CREATED_IDS.length = 0;
	}
});

describe("P2756: workflow_name creation-path single-source (AC-6)", () => {
	it("each proposal type seeds proposal.workflow_name from proposal_type_config", async () => {
		const { rows: types } = await query<{ type: string; workflow_name: string }>(
			`SELECT type, workflow_name FROM roadmap_proposal.proposal_type_config ORDER BY type`,
		);

		expect(types.length).toBeGreaterThan(0);

		const testAudit = JSON.stringify([{ TS: new Date().toISOString(), Agent: "p2756-test", Activity: "Created" }]);

		for (const { type, workflow_name: expectedWorkflowName } of types) {
			const { rows } = await query<{ id: number; workflow_name: string }>(
				`INSERT INTO roadmap_proposal.proposal
				   (type, title, summary, audit)
				 VALUES ($1, $2, 'P2756 regression test', $3::jsonb)
				 RETURNING id, workflow_name`,
				[type, `P2756-test-${type}`, testAudit],
			);

			const created = rows[0];
			CREATED_IDS.push(created.id);

			expect(created.workflow_name).toBe(expectedWorkflowName);

			// Also verify workflows row matches
			const { rows: wfRows } = await query<{ template_name: string }>(
				`SELECT wt.name AS template_name
				 FROM roadmap.workflows w
				 JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
				 WHERE w.proposal_id = $1`,
				[created.id],
			);

			expect(wfRows).toHaveLength(1);
			expect(wfRows[0].template_name).toBe(expectedWorkflowName);
		}
	});
});

describe("P2756: CI audit — no non-terminal workflow_name drift (AC-7)", () => {
	it("no non-terminal proposal has workflow_name differing from its workflows-table template", async () => {
		const { rows: drifted } = await query<{
			id: number;
			display_id: string;
			status: string;
			type: string;
			prop_workflow_name: string;
			template_name: string;
		}>(
			`SELECT
			   p.id,
			   p.display_id,
			   p.status,
			   p.type,
			   p.workflow_name  AS prop_workflow_name,
			   wt.name          AS template_name
			 FROM roadmap_proposal.proposal p
			 JOIN roadmap.workflows w ON w.proposal_id = p.id
			 JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
			 WHERE p.workflow_name IS DISTINCT FROM wt.name
			   AND p.status NOT IN ('Complete', 'Obsolete')
			   AND p.display_id NOT LIKE 'P3326-%'
			 ORDER BY p.id`,
		);

		if (drifted.length > 0) {
			const summary = drifted
				.map(
					(r) =>
						`  #${r.id} (${r.display_id}) status=${r.status} type=${r.type}: proposal.workflow_name='${r.prop_workflow_name}' != template='${r.template_name}'`,
				)
				.join("\n");
			throw new Error(
				`${drifted.length} non-terminal proposal(s) have workflow_name drift:\n${summary}`,
			);
		}

		expect(drifted).toHaveLength(0);
	});
});
