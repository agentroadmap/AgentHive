import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * P906 (P902-C): the gate-advance trigger fn_apply_gate_advance must apply a
 * status advance WITHOUT `SET LOCAL app.gate_bypass = 'true'`. The proof of
 * safety is that the BEFORE UPDATE guard (fn_guard_gate_advance) finds the
 * gate_decision_log row in the SAME transaction (Branch B) and passes anyway.
 *
 * These are env-gated live-DB tests. They apply migration 264 INSIDE a
 * transaction that is always rolled back, so the live trigger definition and
 * all test rows are reverted — the live DB is never polluted.
 *
 *   AGENTHIVE_RESOLVER_DB_TEST=1 \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p906-gate-bypass-removal.test.ts
 */
const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_264 = join(
	__dirname,
	"..",
	"264-p906-gate-advance-drop-bypass.sql",
);

describe("P906: gate advance without app.gate_bypass", { skip: !DB_TEST }, () => {
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

	// Seed a throwaway REVIEW proposal + registered decider, returning its id.
	// id is a GENERATED ALWAYS identity column; display_id is auto-assigned by
	// trg_proposal_display_id. Everything is rolled back at end of test.
	async function seedReviewProposal(
		client: import("pg").Client,
		decider: string,
	): Promise<number> {
		await client.query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
			 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			[decider],
		);
		const { rows } = await client.query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, priority, audit)
			 VALUES ('p906-test-proposal', 'issue', 'REVIEW', 'mature', 'high', '{}'::jsonb)
			 RETURNING id`,
		);
		return rows[0].id;
	}

	test("AC-1: migration 264 source contains no 'SET LOCAL app.gate_bypass'", () => {
		const sql = readFileSync(MIGRATION_264, "utf8");
		// The bypass SET LOCAL statement must not appear as live DDL. (Comments
		// referencing the removal in prose are fine; assert on the executable
		// statement form `SET LOCAL app.gate_bypass = 'true'`.)
		assert.ok(
			!/^\s*SET\s+LOCAL\s+app\.gate_bypass\s*=/im.test(sql),
			"migration 264 must not SET LOCAL app.gate_bypass in the trigger body",
		);
	});

	test(
		"AC-3: gate_decision advance flips status without bypass; guard still active",
		async () => {
			await withRollback(async (client) => {
				const decider = "p906-test-decider";
				const pid = await seedReviewProposal(client, decider);

				// Apply the P906 trigger redefinition (no bypass) inside this txn.
				await client.query(readFileSync(MIGRATION_264, "utf8"));

				// Sanity: bypass flag is unset for this session.
				const before = await client.query<{ bypass: string | null }>(
					`SELECT current_setting('app.gate_bypass', true) AS bypass`,
				);
				assert.notStrictEqual(
					before.rows[0].bypass,
					"true",
					"precondition: app.gate_bypass must not be pre-set",
				);

				// Drive a real gate advance the way the MCP does: INSERT an
				// 'advance' row into gate_decision_log. The AFTER INSERT trigger
				// runs fn_apply_gate_advance → UPDATE proposal.status → BEFORE
				// UPDATE guard fn_guard_gate_advance, which must pass via Branch B
				// (same-transaction gate_decision_log visibility) — NOT via bypass.
				await client.query(
					`INSERT INTO roadmap_proposal.gate_decision_log
					   (proposal_id, from_state, to_state, decision, decided_by)
					 VALUES ($1, 'REVIEW', 'DEVELOP', 'advance', $2)`,
					[pid, decider],
				);

				const after = await client.query<{ status: string }>(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[pid],
				);
				assert.strictEqual(
					after.rows[0].status,
					"DEVELOP",
					"gate advance must flip status to DEVELOP without app.gate_bypass",
				);

				// The bypass flag must STILL be unset after the trigger ran —
				// proof the trigger no longer sets it.
				const post = await client.query<{ bypass: string | null }>(
					`SELECT current_setting('app.gate_bypass', true) AS bypass`,
				);
				assert.notStrictEqual(
					post.rows[0].bypass,
					"true",
					"trigger must not leave app.gate_bypass set",
				);
			});
		},
	);

	test(
		"AC-3 (negative): guard rejects a bare status UPDATE with no decision log",
		async () => {
			await withRollback(async (client) => {
				const decider = "p906-test-decider-neg";
				const pid = await seedReviewProposal(client, decider);
				await client.query(readFileSync(MIGRATION_264, "utf8"));

				await assert.rejects(
					() =>
						client.query(
							`UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = $1`,
							[pid],
						),
					/requires a gate decision/,
					"guard must block a bare UPDATE with no gate_decision_log + no bypass",
				);
			});
		},
	);
});
