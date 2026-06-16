import assert from "node:assert";
import { describe, test, before } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P3563 AC-9: async re-execution validator flips a PASS whose test-evidence
 * re-run FAILS to 'fail'. DB-backed (PGDATABASE=agenthive_p3563_test).
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive_p3563_test \
 *     node --import jiti/register --test \
 *     src/core/gate/__tests__/p3563-ac-revalidator.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

describe("P3563 AC-9: AC re-validator", { skip: !DB_TEST }, () => {
	let query: any;
	let revalidateProposalAcs: any;

	before(async () => {
		({ query } = await import("../../../postgres/pool.ts"));
		({ revalidateProposalAcs } = await import("../ac-revalidator.ts"));
	});

	test("AC-9: a behavioral/test PASS whose re-run FAILS is flipped to fail; a missing-file PASS too", async () => {
		// Create a temp dir with a failing test file and an existing file.
		const dir = mkdtempSync(join(tmpdir(), "p3563-reval-"));
		const failing = join(dir, "failing.test.ts");
		writeFileSync(failing, `import { test } from "node:test";\nimport assert from "node:assert";\ntest("x", () => assert.strictEqual(1, 2));\n`);
		const existing = join(dir, "present.ts");
		writeFileSync(existing, "export const x = 1;\n");

		const { rows: pr } = await query(
			`INSERT INTO roadmap_proposal.proposal (title,type,status,maturity,priority,audit)
			 VALUES ('p3563-reval','feature','DEVELOP','mature','high','{}'::jsonb) RETURNING id`);
		const pid = pr[0].id;
		try {
			// AC1: behavioral/test pointing at the FAILING test (absolute path).
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				   (proposal_id,item_number,criterion_text,status,details,verification_notes)
				 VALUES ($1,1,'reexec','pass',$2::jsonb,'ok')`,
				[pid, JSON.stringify({ category: "behavioral/test", test_file: failing, test_names: ["x"], result: "pass", output_snippet: "ok" })]);
			// AC2: file/module pointing at a MISSING file.
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				   (proposal_id,item_number,criterion_text,status,details,verification_notes)
				 VALUES ($1,2,'artifact','pass',$2::jsonb,'ok')`,
				[pid, JSON.stringify({ category: "file/module", files: ["does/not/exist.ts"], symbols: ["x"], grep_evidence: "n/a" })]);
			// AC3: file/module pointing at the EXISTING file (should stay pass).
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				   (proposal_id,item_number,criterion_text,status,details,verification_notes)
				 VALUES ($1,3,'ok-artifact','pass',$2::jsonb,'ok')`,
				[pid, JSON.stringify({ category: "file/module", files: ["present.ts"], symbols: ["x"], grep_evidence: "n/a" })]);

			const out = await revalidateProposalAcs(pid, { worktreeRoot: "/", worktree: dir.replace(/^\//, ""), timeoutMs: 60_000 });

			assert.ok(out.flippedToFail >= 2, `expected ≥2 flips, got ${out.flippedToFail}: ${JSON.stringify(out)}`);

			const { rows: after } = await query(
				`SELECT item_number, status FROM roadmap_proposal.proposal_acceptance_criteria
				  WHERE proposal_id=$1 ORDER BY item_number`, [pid]);
			const byItem = Object.fromEntries(after.map((r: any) => [r.item_number, r.status]));
			assert.strictEqual(byItem[1], "fail", "failing test-evidence pass → fail");
			assert.strictEqual(byItem[2], "fail", "missing-file pass → fail");
			assert.strictEqual(byItem[3], "pass", "existing-file pass stays pass");
		} finally {
			await query(`DELETE FROM roadmap_proposal.proposal WHERE id=$1`, [pid]);
		}
	});
});
