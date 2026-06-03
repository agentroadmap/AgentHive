/**
 * P900: Durable escalation_failure_count integration test
 *
 * Verifies that the poison-pill quarantine threshold survives timeout-cron
 * process restarts and multi-pod deployments by relying on the DB-backed
 * escalation_failure_count column rather than an in-memory counter.
 *
 * Suite layout:
 *   1. Schema: escalation_failure_count column exists with correct defaults.
 *   2. Success path: successful escalation resets counter to 0.
 *   3. Cross-restart accumulation (core P900 scenario):
 *        - 2 failures on "pod A" instance of runEscalationPass
 *        - fresh pool (simulating restart / new pod)
 *        - 1 more failure → row quarantined as POISON_PILL_DEAD_LETTER
 *   4. Below-threshold retry: escalated_at is NULL after failure (row re-queued).
 *   5. At-threshold poison pill: escalated_at is NOT NULL after quarantine.
 */

import assert from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { Pool } from "pg";
import { runEscalationPass } from "../../src/infra/messaging/timeout-cron.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STAMP = Date.now();
const SENDER = `p900-test-sender-${STAMP}`;
const RECEIVER = `p900-test-receiver-${STAMP}`;
const ESCALATION_RECIPIENT = "liaison_hub";
const POISON_PILL = "POISON_PILL_DEAD_LETTER";

function newPool(): Pool {
	return new Pool();
}

/**
 * Creates a Pool proxy that intercepts any query whose text contains the given
 * substring and throws instead. All other queries are forwarded to the real pool.
 */
function makeFaultingPool(realPool: Pool, injectErrorOn: string): Pool {
	const handler: ProxyHandler<Pool> = {
		get(target, prop) {
			if (prop !== "query") return (target as any)[prop];
			return async (text: string, values?: unknown[]) => {
				// Check both the SQL text and the values array. "system:timeout-escalator"
				// is passed as $1 (a value), not embedded in the SQL string, so we must
				// also inspect values to correctly inject escalation-notice failures.
				const inText = typeof text === "string" && text.includes(injectErrorOn);
				const inValues = Array.isArray(values) &&
					values.some((v) => typeof v === "string" && v.includes(injectErrorOn));
				if (inText || inValues) {
					throw new Error(`[mock] injected failure for: ${injectErrorOn}`);
				}
				return (target as any).query(text, values);
			};
		},
	};
	return new Proxy(realPool, handler);
}

// Seed agent_registry + message_ledger + message_timeout_tracking for a single
// test message. Returns the numeric message_id.
async function seedTestMessage(pool: Pool): Promise<string> {
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
		 VALUES ($1, 'tool', 'active'), ($2, 'tool', 'active')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[SENDER, RECEIVER],
	);

	// Ensure the task message_type_contract row exists (idempotent).
	await pool.query(
		`INSERT INTO roadmap.message_type_contract
		   (message_type, ack_required, timeout_seconds, escalation_recipient)
		 VALUES ('task', true, 300, $1)
		 ON CONFLICT (message_type) DO NOTHING`,
		[ESCALATION_RECIPIENT],
	);

	const { rows: ledgerRows } = await pool.query<{ id: string }>(
		`INSERT INTO roadmap.message_ledger
		   (from_agent, to_agent, message_type, message_content)
		 VALUES ($1, $2, 'task', 'p900 test payload')
		 RETURNING id::text`,
		[SENDER, RECEIVER],
	);
	const messageId = ledgerRows[0].id;

	// Insert timeout tracking row with timeout_at in the past so the escalation
	// CTE's WHERE clause (mtt.timeout_at < now()) picks it up immediately.
	await pool.query(
		`INSERT INTO roadmap.message_timeout_tracking
		   (message_id, timeout_at)
		 VALUES ($1, now() - interval '1 second')`,
		[messageId],
	);

	return messageId;
}

async function getTrackingRow(
	pool: Pool,
	messageId: string,
): Promise<{
	escalation_failure_count: number;
	escalation_recipient: string | null;
	escalated_at: Date | null;
}> {
	const { rows } = await pool.query(
		`SELECT escalation_failure_count, escalation_recipient, escalated_at
		 FROM roadmap.message_timeout_tracking
		 WHERE message_id = $1`,
		[messageId],
	);
	return rows[0];
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let realPool: Pool;
const createdMessageIds: string[] = [];

before(async () => {
	realPool = newPool();
});

afterEach(async () => {
	if (createdMessageIds.length > 0) {
		// Delete tracking rows first (FK child), then ledger rows (FK parent).
		await realPool.query(
			`DELETE FROM roadmap.message_timeout_tracking
			 WHERE message_id = ANY($1::bigint[])`,
			[createdMessageIds],
		);
		await realPool.query(
			`DELETE FROM roadmap.message_ledger WHERE id = ANY($1::bigint[])`,
			[createdMessageIds],
		);
		createdMessageIds.length = 0;
	}
});

after(async () => {
	await realPool.end();
});

// ─── Suite 1: Schema presence ─────────────────────────────────────────────────

describe("P900 schema: escalation_failure_count column", () => {
	it("column exists with integer type and default 0", async () => {
		const { rows } = await realPool.query<{
			column_name: string;
			data_type: string;
			column_default: string;
		}>(
			`SELECT column_name, data_type, column_default
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap'
			   AND table_name   = 'message_timeout_tracking'
			   AND column_name  = 'escalation_failure_count'`,
		);
		assert.strictEqual(rows.length, 1, "escalation_failure_count column is missing");
		assert.strictEqual(rows[0].data_type, "integer");
		assert.ok(
			rows[0].column_default?.includes("0"),
			`Expected DEFAULT 0, got: ${rows[0].column_default}`,
		);
	});
});

// ─── Suite 2: Success path counter reset ──────────────────────────────────────

describe("P900 success path: escalation notice delivered", () => {
	it("resets escalation_failure_count to 0 after a successful escalation", async () => {
		const messageId = await seedTestMessage(realPool);
		createdMessageIds.push(messageId);

		// Pre-set failure count to simulate prior failures.
		await realPool.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 2
			 WHERE message_id = $1`,
			[messageId],
		);

		// Run with the real pool — escalation notice INSERT should succeed.
		await runEscalationPass(realPool);

		const row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(
			row.escalation_failure_count,
			0,
			"failure count was not reset after successful escalation",
		);
	});
});

// ─── Suite 3: Cross-restart counter accumulation (core P900 AC) ──────────────

describe("P900 cross-restart: poison-pill quarantine survives restart", () => {
	it("accumulates failures across two pool instances and quarantines at threshold=3", async () => {
		const messageId = await seedTestMessage(realPool);
		createdMessageIds.push(messageId);

		// "Pod A": two escalation failures (escalation INSERT throws).
		const poolA = makeFaultingPool(realPool, "system:timeout-escalator");

		// First failure tick: CTE sets escalated_at, notice fails, counter → 1,
		// then escalated_at is reset to NULL so next tick can re-select the row.
		await runEscalationPass(poolA);
		let row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(row.escalation_failure_count, 1, "expected 1 failure after first tick");
		assert.strictEqual(
			row.escalated_at,
			null,
			"escalated_at must be NULL after below-threshold failure (row re-queued)",
		);

		// Second failure tick (still pod A, still below threshold=3).
		await runEscalationPass(poolA);
		row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(row.escalation_failure_count, 2, "expected 2 failures after second tick");
		assert.strictEqual(row.escalated_at, null, "escalated_at must still be NULL after 2nd failure");

		// Simulate process restart / new pod by creating a completely fresh Pool.
		// The old in-memory state is gone — only the DB counter survives.
		const poolB = makeFaultingPool(newPool(), "system:timeout-escalator");

		// Third failure tick (pod B, hits threshold=3 → POISON_PILL_DEAD_LETTER).
		await runEscalationPass(poolB);
		await (poolB as any).end?.();

		row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(
			row.escalation_failure_count,
			3,
			`expected failure_count=3 at quarantine, got ${row.escalation_failure_count}`,
		);
		assert.strictEqual(
			row.escalation_recipient,
			POISON_PILL,
			`expected escalation_recipient='${POISON_PILL}', got '${row.escalation_recipient}'`,
		);
		// escalated_at must remain set so the CTE never re-selects this row.
		assert.notStrictEqual(
			row.escalated_at,
			null,
			"escalated_at must be non-NULL after poison-pill quarantine (prevents re-queue)",
		);
	});
});

// ─── Suite 4: Below-threshold re-queue ───────────────────────────────────────

describe("P900 below-threshold: escalated_at is reset after failure", () => {
	it("sets escalated_at=NULL so the CTE can re-select the row on next tick", async () => {
		const messageId = await seedTestMessage(realPool);
		createdMessageIds.push(messageId);

		const faultPool = makeFaultingPool(realPool, "system:timeout-escalator");
		await runEscalationPass(faultPool);

		const row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(
			row.escalated_at,
			null,
			"escalated_at must be NULL after first failure so row is re-queued",
		);
		assert.strictEqual(row.escalation_failure_count, 1);
	});
});

// ─── Suite 5: At-threshold escalated_at persistence ──────────────────────────

describe("P900 at-threshold: escalated_at is NOT reset after quarantine", () => {
	it("keeps escalated_at set after POISON_PILL_DEAD_LETTER marking", async () => {
		const messageId = await seedTestMessage(realPool);
		createdMessageIds.push(messageId);

		// Pre-set to one below threshold so the next tick is the trigger tick.
		await realPool.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 2
			 WHERE message_id = $1`,
			[messageId],
		);

		const faultPool = makeFaultingPool(realPool, "system:timeout-escalator");
		await runEscalationPass(faultPool);

		const row = await getTrackingRow(realPool, messageId);
		assert.strictEqual(
			row.escalation_recipient,
			POISON_PILL,
			"row must be quarantined at failure_count=3",
		);
		assert.notStrictEqual(
			row.escalated_at,
			null,
			"escalated_at must remain set after poison-pill marking",
		);
	});
});
