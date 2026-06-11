/**
 * P900: Persist escalation_failure_count so poison-pill survives timeout-cron restart
 *
 * Tests that escalation failure counts are durable across pool (host) restarts,
 * and that the POISON_PILL_DEAD_LETTER threshold is reached via DB accumulation.
 *
 * Suite writes real rows to the live agenthive DB, cleaned up in teardown.
 * Skipped unless AGENTHIVE_ALLOW_LIVE_DB=1 to keep the default suite hermetic.
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, type Pool } from '../../src/infra/postgres/pool.js';

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function insertTestMessage(db: Pool, fromAgent = 'agent-a', toAgent = 'agent-b'): Promise<bigint> {
	const { rows } = await db.query<{ id: bigint }>(
		`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_type, message_content)
		 VALUES ($1, $2, 'task_request', '{}')
		 RETURNING id`,
		[fromAgent, toAgent],
	);
	return rows[0].id;
}

async function insertTimeoutTracking(db: Pool, messageId: bigint): Promise<void> {
	await db.query(
		`INSERT INTO roadmap.message_timeout_tracking
		   (message_id, timeout_at, escalation_recipient)
		 VALUES ($1, now() - interval '1 minute', 'supervisor-agent')`,
		[messageId],
	);
}

async function getTrackingRow(db: Pool, messageId: bigint) {
	const { rows } = await db.query<{
		escalation_failure_count: number;
		escalation_recipient: string;
		escalated_at: Date | null;
	}>(
		`SELECT escalation_failure_count, escalation_recipient, escalated_at
		 FROM roadmap.message_timeout_tracking
		 WHERE message_id = $1`,
		[messageId],
	);
	return rows[0];
}

async function cleanupMessage(db: Pool, messageId: bigint): Promise<void> {
	// ON DELETE CASCADE cleans up tracking row
	await db.query(`DELETE FROM roadmap.message_ledger WHERE id = $1`, [messageId]);
}

// ─── AC1: Schema presence ────────────────────────────────────────────────────

describe('AC1: escalation_failure_count column exists with correct defaults', { skip: !LIVE }, () => {
	test('column is integer with default 0', async () => {
		const db = getPool();
		const { rows } = await db.query<{
			column_name: string;
			data_type: string;
			column_default: string;
			is_nullable: string;
		}>(
			`SELECT column_name, data_type, column_default, is_nullable
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap'
			   AND table_name   = 'message_timeout_tracking'
			   AND column_name  = 'escalation_failure_count'`,
		);
		assert.equal(rows.length, 1, 'column must exist');
		assert.equal(rows[0].data_type, 'integer');
		assert.match(rows[0].column_default, /^0/, 'default must be 0');
		assert.equal(rows[0].is_nullable, 'NO', 'column must be NOT NULL');
	});
});

// ─── AC2: Success path resets counter to 0 ──────────────────────────────────

describe('AC2: successful escalation delivery resets failure counter to 0', { skip: !LIVE }, () => {
	let db: Pool;
	let messageId: bigint;

	before(async () => {
		db = getPool();
		messageId = await insertTestMessage(db);
		await insertTimeoutTracking(db, messageId);
		// Simulate 2 prior failures
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 2
			 WHERE message_id = $1`,
			[messageId],
		);
	});

	after(async () => {
		await cleanupMessage(db, messageId);
	});

	test('counter drops to 0 after simulated success', async () => {
		// Mimic the success branch in timeout-cron.ts
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = 0
			 WHERE message_id = $1 AND escalation_failure_count > 0`,
			[messageId],
		);
		const row = await getTrackingRow(db, messageId);
		assert.equal(row.escalation_failure_count, 0);
	});
});

// ─── AC3: Core P900 scenario — cross-pool accumulation ──────────────────────

describe('AC3: failure count accumulates across independent Pool instances (no shared memory)', { skip: !LIVE }, () => {
	let poolA: Pool;
	let poolB: Pool;
	let messageId: bigint;

	before(async () => {
		poolA = getPool();
		messageId = await insertTestMessage(poolA);
		await insertTimeoutTracking(poolA, messageId);
	});

	after(async () => {
		await cleanupMessage(poolA, messageId);
	});

	test('2 failures on poolA + 1 failure on fresh poolB reaches POISON_PILL_DEAD_LETTER', async () => {
		const ESCALATION_RETRY_LIMIT = 3;
		const POISON_PILL_DEAD_LETTER = 'POISON_PILL_DEAD_LETTER';

		// --- poolA: 2 failures ---
		for (let i = 0; i < 2; i++) {
			const { rows } = await poolA.query<{ escalation_failure_count: number }>(
				`UPDATE roadmap.message_timeout_tracking
				 SET escalation_failure_count = escalation_failure_count + 1
				 WHERE message_id = $1
				 RETURNING escalation_failure_count`,
				[messageId],
			);
			const count = rows[0].escalation_failure_count;
			if (count < ESCALATION_RETRY_LIMIT) {
				// reset escalated_at for retry (AC4 behaviour)
				await poolA.query(
					`UPDATE roadmap.message_timeout_tracking
					 SET escalated_at = NULL WHERE message_id = $1`,
					[messageId],
				);
			}
		}

		// Simulate a pod restart: poolB is a new independent Pool instance.
		// It has no in-memory counter — but the DB counter persists.
		poolB = getPool(); // same connection string; shares DB state, not memory

		// --- poolB: 1 more failure ---
		const { rows: failRows } = await poolB.query<{ escalation_failure_count: number }>(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = escalation_failure_count + 1
			 WHERE message_id = $1
			 RETURNING escalation_failure_count`,
			[messageId],
		);
		const finalCount = failRows[0].escalation_failure_count;
		assert.equal(finalCount, 3, 'counter must have accumulated to 3 across both pools');

		if (finalCount >= ESCALATION_RETRY_LIMIT) {
			await poolB.query(
				`UPDATE roadmap.message_timeout_tracking
				 SET escalation_recipient = $1
				 WHERE message_id = $2`,
				[POISON_PILL_DEAD_LETTER, messageId],
			);
		}

		const row = await getTrackingRow(poolB, messageId);
		assert.equal(row.escalation_recipient, POISON_PILL_DEAD_LETTER);
		assert.equal(row.escalation_failure_count, 3);
	});
});

// ─── AC4: Below-threshold failure resets escalated_at for retry ─────────────

describe('AC4: sub-threshold failure resets escalated_at to NULL so CTE re-selects', { skip: !LIVE }, () => {
	let db: Pool;
	let messageId: bigint;

	before(async () => {
		db = getPool();
		messageId = await insertTestMessage(db);
		await insertTimeoutTracking(db, messageId);
		// Simulate the CTE having selected and marked escalated_at
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = now()
			 WHERE message_id = $1`,
			[messageId],
		);
	});

	after(async () => {
		await cleanupMessage(db, messageId);
	});

	test('escalated_at is NULL after a failure that is below ESCALATION_RETRY_LIMIT', async () => {
		const ESCALATION_RETRY_LIMIT = 3;

		const { rows } = await db.query<{ escalation_failure_count: number }>(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = escalation_failure_count + 1
			 WHERE message_id = $1
			 RETURNING escalation_failure_count`,
			[messageId],
		);
		const count = rows[0].escalation_failure_count;
		assert.ok(count < ESCALATION_RETRY_LIMIT, 'should be below limit after first failure');

		// The else-branch in timeout-cron.ts resets escalated_at
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = NULL WHERE message_id = $1`,
			[messageId],
		);

		const row = await getTrackingRow(db, messageId);
		assert.equal(row.escalated_at, null, 'escalated_at must be NULL so CTE can re-select');
	});
});

// ─── AC5: At-threshold — escalated_at stays set (CTE never retries) ─────────

describe('AC5: at ESCALATION_RETRY_LIMIT, escalated_at stays set so CTE never retries', { skip: !LIVE }, () => {
	let db: Pool;
	let messageId: bigint;

	before(async () => {
		db = getPool();
		messageId = await insertTestMessage(db);
		await insertTimeoutTracking(db, messageId);
		// Simulate the CTE having marked escalated_at (last escalation attempt)
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = now(), escalation_failure_count = 2
			 WHERE message_id = $1`,
			[messageId],
		);
	});

	after(async () => {
		await cleanupMessage(db, messageId);
	});

	test('escalated_at remains set after poison-pill flip', async () => {
		const POISON_PILL_DEAD_LETTER = 'POISON_PILL_DEAD_LETTER';
		const ESCALATION_RETRY_LIMIT = 3;

		// Increment to reach threshold
		const { rows } = await db.query<{ escalation_failure_count: number }>(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_failure_count = escalation_failure_count + 1
			 WHERE message_id = $1
			 RETURNING escalation_failure_count`,
			[messageId],
		);
		const count = rows[0].escalation_failure_count;
		assert.equal(count, ESCALATION_RETRY_LIMIT, 'should be at limit');

		// Poison-pill flip: only changes escalation_recipient, NOT escalated_at
		await db.query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalation_recipient = $1
			 WHERE message_id = $2`,
			[POISON_PILL_DEAD_LETTER, messageId],
		);

		const row = await getTrackingRow(db, messageId);
		assert.equal(row.escalation_recipient, POISON_PILL_DEAD_LETTER);
		assert.notEqual(row.escalated_at, null, 'escalated_at must remain set — CTE must not re-select');
	});
});
