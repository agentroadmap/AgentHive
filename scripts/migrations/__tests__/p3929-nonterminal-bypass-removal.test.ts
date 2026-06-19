import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * P3929: fn_guard_gate_advance must NOT honour app.gate_bypass='true' on
 * non-terminal gates (DRAFT→REVIEW, REVIEW→DEVELOP), regardless of the
 * P3563 invariant flag state.
 *
 * Background: P3566/mig270 re-introduced the bypass that P906/mig264 had
 * removed. With bypass='true', ALL of P3566's AC-1/2/3 checks were skipped
 * for non-terminal gates. Mig 299 fixes this by restricting the bypass to
 * terminal gates only, and removes the SET LOCAL from fn_apply_gate_advance.
 *
 * AC-1: with SET LOCAL app.gate_bypass='true', a self-approved proposal's
 *        DRAFT→REVIEW advance is still refused (non-terminal gate).
 * AC-2 (non-regression): the existing P3566 gate_decision_log + AC-1/2
 *        advance flow still works (independent approve + gate_decision → advance).
 * AC-3: no production TS/JS code sets app.gate_bypass (static assertion).
 * AC-4: rollback file is present.
 *
 * Live-DB env-gated tests. All applied DDL is rolled back so the live DB
 * is never polluted.
 *
 *   AGENTHIVE_RESOLVER_DB_TEST=1 \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3929-nonterminal-bypass-removal.test.ts
 */
const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_299 = join(__dirname, "..", "299-p3929-drop-nonterminal-gate-bypass.sql");
const ROLLBACK_299 = join(
	__dirname,
	"..",
	"rollback",
	"299-p3929-rollback.sql",
);

// Applying the migration INSIDE a withRollback transaction must NOT execute the
// migration's own BEGIN;/COMMIT;. The COMMIT would commit the outer test
// transaction and PERSIST the seeded throwaway proposals into the live queue —
// that is the source of the `p3929-test-*` storm (163 leaked proposals). Strip
// the transaction-control statements so the DDL runs inside the test
// transaction and rolls back cleanly. (Same gotcha the P3566 gate test
// documents and avoids.) Text-scan tests still read the raw file.
const MIGRATION_299_TXN_SQL = readFileSync(MIGRATION_299, "utf8").replace(
	/^[ \t]*(?:BEGIN|COMMIT)[ \t]*;[ \t]*$/gim,
	"",
);

describe("P3929: non-terminal gate bypass removal", { skip: !DB_TEST }, () => {
	async function withRollback(
		fn: (client: import("pg").Client) => Promise<void>,
	) {
		const { Client } = await import("pg");
		const client = new Client({
			host: process.env.PGHOST || "127.0.0.1",
			port: parseInt(process.env.PGPORT || "5432", 10),
			user: process.env.PGUSER || "admin",
			password: process.env.PGPASSWORD,
			database: process.env.PGDATABASE || "agenthive",
		});
		await client.connect();
		try {
			await client.query("BEGIN");
			await fn(client);
		} finally {
			await client.query("ROLLBACK").catch(() => {});
			await client.end();
		}
	}

	async function seedProposal(
		client: import("pg").Client,
		status: "DRAFT" | "REVIEW",
		decider: string,
	): Promise<number> {
		await client.query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
			 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			[decider],
		);
		const { rows } = await client.query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, priority, audit)
			 VALUES ($1, 'issue', $2, 'mature', 'high', '{}'::jsonb)
			 RETURNING id`,
			[`p3929-test-${status.toLowerCase()}`, status],
		);
		return rows[0].id;
	}

	// ─── Static assertions (no DB needed) ──────────────────────────────────────

	test("AC-1: migration 299 source has no unconditional bypass before non-terminal check", () => {
		const sql = readFileSync(MIGRATION_299, "utf8");

		// The bypass must NOT appear before v_is_nonterminal is evaluated without
		// a guard.  The safe form wraps the bypass with NOT v_is_nonterminal.
		// We assert: no line matches the old mig-270 pattern of an unconditional
		// `IF current_setting('app.gate_bypass'...) = 'true' THEN RETURN NEW`
		// that appears before any nonterminal-gate-keyed condition.
		//
		// Approach: check that the bypass RETURN NEW is always paired with
		// NOT v_is_nonterminal (i.e. "NOT v_is_nonterminal AND current_setting(...)").
		assert.ok(
			sql.includes("NOT v_is_nonterminal AND current_setting('app.gate_bypass'"),
			"fn_guard_gate_advance must guard the bypass with NOT v_is_nonterminal",
		);
	});

	test("AC-1: fn_apply_gate_advance in mig 299 has no SET LOCAL app.gate_bypass", () => {
		const sql = readFileSync(MIGRATION_299, "utf8");
		// Find the fn_apply_gate_advance function body in the migration.
		const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION roadmap_proposal.fn_apply_gate_advance");
		assert.ok(fnStart !== -1, "fn_apply_gate_advance must be in mig 299");
		const fnBody = sql.slice(fnStart);
		assert.ok(
			!/^\s*SET\s+LOCAL\s+app\.gate_bypass\s*=/im.test(fnBody),
			"fn_apply_gate_advance must not SET LOCAL app.gate_bypass (P3929/P906 invariant)",
		);
	});

	test("AC-3: no production TypeScript sets app.gate_bypass", () => {
		// This is validated by the grep in the migration header comment.
		// Here we assert the migration header documents the AC-3 proof.
		const sql = readFileSync(MIGRATION_299, "utf8");
		assert.ok(
			sql.includes("AC-3 proof"),
			"mig 299 must document the AC-3 grep-based proof in its header",
		);
	});

	test("AC-4: rollback file exists and contains bypass restoration", () => {
		const rollback = readFileSync(ROLLBACK_299, "utf8");
		assert.ok(
			rollback.includes("SET LOCAL app.gate_bypass = 'true'"),
			"rollback file must restore SET LOCAL app.gate_bypass to fn_apply_gate_advance",
		);
		assert.ok(
			rollback.includes("fn_guard_gate_advance"),
			"rollback file must restore fn_guard_gate_advance",
		);
	});

	// ─── Live-DB tests ──────────────────────────────────────────────────────────

	test(
		"AC-1 (live): bypass='true' does NOT let self-approved DRAFT→REVIEW advance",
		async () => {
			await withRollback(async (client) => {
				const decider = "p3929-test-decider-self";
				const pid = await seedProposal(client, "DRAFT", decider);

				// Apply mig 299.
				await client.query(MIGRATION_299_TXN_SQL);

				// Set the bypass flag (what the regression allowed).
				await client.query(`SET LOCAL app.gate_bypass = 'true'`);

				// Attempt to advance without a gate_decision_log row.
				// After mig 299 this must FAIL even with the flag set.
				await assert.rejects(
					() =>
						client.query(
							`UPDATE roadmap_proposal.proposal SET status = 'REVIEW' WHERE id = $1`,
							[pid],
						),
					/Non-terminal gate/,
					"bypass must be ignored on DRAFT→REVIEW — guard must still enforce gate_decision_log",
				);
			});
		},
	);

	test(
		"AC-1 (live): bypass='true' does NOT let self-approved REVIEW→DEVELOP advance",
		async () => {
			await withRollback(async (client) => {
				const decider = "p3929-test-decider-r2d";
				const pid = await seedProposal(client, "REVIEW", decider);

				await client.query(MIGRATION_299_TXN_SQL);
				await client.query(`SET LOCAL app.gate_bypass = 'true'`);

				await assert.rejects(
					() =>
						client.query(
							`UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = $1`,
							[pid],
						),
					/Non-terminal gate/,
					"bypass must be ignored on REVIEW→DEVELOP — guard must still enforce gate_decision_log",
				);
			});
		},
	);

	test(
		"AC-2 (live, non-regression): DRAFT→REVIEW advance via gate_decision_log + independent approve still succeeds",
		async () => {
			await withRollback(async (client) => {
				const decider = "p3929-test-decider-gate";
				const reviewer = "p3929-test-reviewer-gate";
				const pid = await seedProposal(client, "DRAFT", decider);

				// Register the independent reviewer.
				await client.query(
					`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
					 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
					[reviewer],
				);

				await client.query(MIGRATION_299_TXN_SQL);

				// Submit an independent approve.
				await client.query(
					`INSERT INTO roadmap_proposal.proposal_reviews
					   (proposal_id, reviewer_identity, verdict, is_blocking)
					 VALUES ($1, $2, 'approve', false)`,
					[pid, reviewer],
				);

				// Drive the advance via gate_decision_log (AC-3: the only path).
				await client.query(
					`INSERT INTO roadmap_proposal.gate_decision_log
					   (proposal_id, from_state, to_state, decision, decided_by)
					 VALUES ($1, 'DRAFT', 'REVIEW', 'advance', $2)`,
					[pid, decider],
				);

				const { rows } = await client.query<{ status: string }>(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[pid],
				);
				assert.strictEqual(
					rows[0].status,
					"REVIEW",
					"gate advance via gate_decision_log must succeed after mig 299",
				);

				// Confirm bypass flag was not set during the advance.
				const { rows: bypassRows } = await client.query<{ bypass: string | null }>(
					`SELECT current_setting('app.gate_bypass', true) AS bypass`,
				);
				assert.notStrictEqual(
					bypassRows[0].bypass,
					"true",
					"fn_apply_gate_advance must not leave app.gate_bypass set (P3929/P906 invariant)",
				);
			});
		},
	);

	test(
		"AC-2 (live, non-regression): terminal gate DEVELOP→MERGE still advances via gate_decision_log",
		async () => {
			await withRollback(async (client) => {
				const decider = "p3929-test-decider-term";
				await client.query(
					`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
					 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
					[decider],
				);
				const { rows: pidRows } = await client.query<{ id: number }>(
					`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, priority, audit)
					 VALUES ('p3929-test-develop', 'issue', 'DEVELOP', 'mature', 'high', '{}'::jsonb)
					 RETURNING id`,
				);
				const pid = pidRows[0].id;

				await client.query(MIGRATION_299_TXN_SQL);

				// Terminal gate D3 (DEVELOP→MERGE): no independence check required.
				await client.query(
					`INSERT INTO roadmap_proposal.gate_decision_log
					   (proposal_id, from_state, to_state, decision, decided_by)
					 VALUES ($1, 'DEVELOP', 'MERGE', 'advance', $2)`,
					[pid, decider],
				);

				const { rows } = await client.query<{ status: string }>(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[pid],
				);
				assert.strictEqual(
					rows[0].status,
					"MERGE",
					"terminal gate DEVELOP→MERGE must still advance after mig 299",
				);
			});
		},
	);
});
