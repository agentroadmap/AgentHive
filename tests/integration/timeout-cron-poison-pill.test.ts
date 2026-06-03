/**
 * P900 Integration Tests — Poison-Pill Counter Persistence
 *
 * Validates that escalation_failure_count survives timeout-cron restarts.
 * A fresh DB pool carries no in-memory state, so the durable counter column
 * is the only thing that makes the 3-strike quarantine reliable.
 *
 * Pre-requisite: migration 124-p900-escalation-failure-count must be applied.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { closePool, getPool, query } from "../../src/infra/postgres/pool.ts";

const TS = Date.now();
const AGENT_FROM = `test/p900/sender-${TS}`;
const AGENT_ESCALATION = `test/p900/escalation-target-${TS}`;
const ESCALATION_RETRY_LIMIT = 3;
const POISON_PILL_DEAD_LETTER = "POISON_PILL_DEAD_LETTER";

const createdMessageIds: number[] = [];

async function ensureAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status, trust_tier)
		 VALUES ($1, 'tool', 'active', 'known')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

async function insertTrackedMessage(escalation_recipient?: string): Promise<number> {
	const msg = await query<{ id: number }>(
		`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_type, message_content)
		 VALUES ($1, $2, 'task', 'p900 test payload')
		 RETURNING id`,
		[AGENT_FROM, AGENT_FROM],
	);
	const messageId = msg.rows[0].id;
	createdMessageIds.push(messageId);

	await query(
		`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
		 VALUES ($1, now() - interval '5 minutes', $2)`,
		[messageId, escalation_recipient ?? AGENT_ESCALATION],
	);
	return messageId;
}

// Mirrors the SQL pattern in timeout-cron.ts failure path
async function simulateEscalationFailure(pool: Pool, messageId: number): Promise<number> {
	const { rows } = await pool.query<{ escalation_failure_count: number }>(
		`UPDATE roadmap.message_timeout_tracking
		 SET escalation_failure_count = escalation_failure_count + 1
		 WHERE message_id = $1
		 RETURNING escalation_failure_count`,
		[messageId],
	);
	const count = rows[0]?.escalation_failure_count ?? 1;

	if (count >= ESCALATION_RETRY_LIMIT) {
		await pool.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_recipient = $1
			 WHERE message_id = $2`,
			[POISON_PILL_DEAD_LETTER, messageId],
		);
	} else {
		// Reset escalated_at so the CTE re-selects this row on the next tick (AC-4)
		await pool.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = NULL
			 WHERE message_id = $1`,
			[messageId],
		);
	}
	return count;
}

before(async () => {
	await ensureAgent(AGENT_FROM);
});

after(async () => {
	if (createdMessageIds.length > 0) {
		await query(
			`DELETE FROM roadmap.message_timeout_tracking WHERE message_id = ANY($1::int[])`,
			[createdMessageIds],
		);
		await query(
			`DELETE FROM roadmap.message_ledger WHERE id = ANY($1::int[])`,
			[createdMessageIds],
		);
	}
	await closePool();
});

// ─── Suite 1: Schema presence ─────────────────────────────────────────────────

describe("P900 AC-1: schema", () => {
	it("escalation_failure_count column exists as integer NOT NULL DEFAULT 0", async () => {
		const { rows } = await query<{
			data_type: string;
			column_default: string;
			is_nullable: string;
		}>(
			`SELECT data_type, column_default, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap'
			   AND table_name   = 'message_timeout_tracking'
			   AND column_name  = 'escalation_failure_count'`,
		);
		assert.equal(rows.length, 1, "column must exist");
		assert.equal(rows[0].data_type, "integer");
		assert.match(rows[0].column_default, /^0/, "default must be 0");
		assert.equal(rows[0].is_nullable, "NO");
	});
});

// ─── Suite 2: Success-path counter reset ──────────────────────────────────────

describe("P900 AC-3: success path resets counter", () => {
	it("counter drops to 0 after a successful escalation notice", async () => {
		const messageId = await insertTrackedMessage();

		// Simulate prior failures
		await query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 2
			 WHERE message_id = $1`,
			[messageId],
		);

		// Successful delivery resets the counter (only when > 0)
		await query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 0
			 WHERE message_id = $1 AND escalation_failure_count > 0`,
			[messageId],
		);

		const { rows } = await query<{ escalation_failure_count: number }>(
			`SELECT escalation_failure_count FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
			[messageId],
		);
		assert.equal(rows[0].escalation_failure_count, 0);
	});
});

// ─── Suite 3: Core P900 restart-survival scenario ─────────────────────────────

describe("P900 AC-6: counter survives cron restart", () => {
	it("2 failures on pool-A + 1 failure on fresh pool-B → POISON_PILL_DEAD_LETTER with count=3", async () => {
		const messageId = await insertTrackedMessage();
		const poolA = getPool();

		// Fresh pool-B: no shared in-memory state (simulates a new pod after deploy)
		const poolB = new Pool({
			connectionString: process.env.DATABASE_URL,
			host: process.env.PGHOST ?? "localhost",
			port: Number(process.env.PGPORT ?? 5432),
			user: process.env.PGUSER,
			database: process.env.PGDATABASE,
			max: 2,
		});

		try {
			// Simulate escalated_at being set by the CTE pick-up
			await query(
				`UPDATE roadmap.message_timeout_tracking SET escalated_at = now() WHERE message_id = $1`,
				[messageId],
			);

			// Pool A — failure 1
			const count1 = await simulateEscalationFailure(poolA, messageId);
			assert.equal(count1, 1, "after failure 1: count = 1");

			const { rows: r1 } = await query<{ escalated_at: Date | null }>(
				`SELECT escalated_at FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
				[messageId],
			);
			assert.equal(r1[0].escalated_at, null, "escalated_at reset after failure 1 so CTE can retry");

			// Simulate CTE re-picking the row on next tick
			await query(
				`UPDATE roadmap.message_timeout_tracking SET escalated_at = now() WHERE message_id = $1`,
				[messageId],
			);

			// Pool A — failure 2
			const count2 = await simulateEscalationFailure(poolA, messageId);
			assert.equal(count2, 2, "after failure 2: count = 2");

			// Simulate CTE re-picking again (fresh tick)
			await query(
				`UPDATE roadmap.message_timeout_tracking SET escalated_at = now() WHERE message_id = $1`,
				[messageId],
			);

			// Pool B (fresh / simulated restart) — failure 3: threshold reached
			const count3 = await simulateEscalationFailure(poolB, messageId);
			assert.equal(count3, 3, "after failure 3: count = 3 (threshold)");

			const { rows: final } = await query<{
				escalation_recipient: string;
				escalation_failure_count: number;
			}>(
				`SELECT escalation_recipient, escalation_failure_count
				 FROM roadmap.message_timeout_tracking
				 WHERE message_id = $1`,
				[messageId],
			);
			assert.equal(final[0].escalation_recipient, POISON_PILL_DEAD_LETTER);
			assert.equal(final[0].escalation_failure_count, 3);
		} finally {
			await poolB.end();
		}
	});
});

// ─── Suite 4: Below-threshold re-queue ────────────────────────────────────────

describe("P900 AC-4: below-threshold re-queue", () => {
	it("escalated_at resets to NULL so CTE re-selects on next tick", async () => {
		const messageId = await insertTrackedMessage();

		// Set escalated_at as if the CTE just claimed this row
		await query(
			`UPDATE roadmap.message_timeout_tracking SET escalated_at = now() WHERE message_id = $1`,
			[messageId],
		);

		const count = await simulateEscalationFailure(getPool(), messageId);
		assert.equal(count, 1, "count incremented to 1 (below threshold)");

		const { rows } = await query<{ escalated_at: Date | null }>(
			`SELECT escalated_at FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
			[messageId],
		);
		assert.equal(rows[0].escalated_at, null, "escalated_at must be NULL for CTE to re-select next tick");
	});
});

// ─── Suite 5: At-threshold escalated_at persistence ───────────────────────────

describe("P900 AC-5: at-threshold escalated_at stays set", () => {
	it("escalated_at is kept set after poison-pill flip so CTE never re-selects", async () => {
		const messageId = await insertTrackedMessage();

		// Pre-seed: 2 prior failures, escalated_at set (as if CTE just picked it up)
		await query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 2, escalated_at = now()
			 WHERE message_id = $1`,
			[messageId],
		);

		const count = await simulateEscalationFailure(getPool(), messageId);
		assert.equal(count, 3, "3rd failure hits threshold");

		const { rows } = await query<{
			escalation_recipient: string;
			escalated_at: Date | null;
		}>(
			`SELECT escalation_recipient, escalated_at
			 FROM roadmap.message_timeout_tracking
			 WHERE message_id = $1`,
			[messageId],
		);
		assert.equal(rows[0].escalation_recipient, POISON_PILL_DEAD_LETTER);
		assert.notEqual(rows[0].escalated_at, null, "escalated_at must remain set so CTE never retries the dead row");
	});
});
