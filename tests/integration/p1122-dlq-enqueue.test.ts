/**
 * P1122: DLQ-enqueue on timeout terminal failure
 * Integration test for dead letter queue routing of unresolved timeout messages
 */

import { describe, it, before, after, expect } from "jsr:@std/testing/bdd";
import { query, getPool, type Pool } from "../../src/infra/postgres/pool.ts";
import { runTimeoutSweep } from "../../src/infra/messaging/timeout-cron.ts";

let db: Pool;

describe("P1122: DLQ-enqueue on timeout terminal failure", () => {
	before(async () => {
		db = getPool();
		// Ensure schema is ready
		await query(
			`SELECT COUNT(*) FROM roadmap.message_timeout_tracking LIMIT 1`,
		);
	});

	after(async () => {
		// Cleanup test data
		await query(
			`DELETE FROM roadmap.dead_letter_queue WHERE failure_reason = 'timeout_after_retries' AND dead_at > NOW() - INTERVAL '1 hour'`,
		);
		await query(
			`DELETE FROM roadmap.message_timeout_tracking WHERE created_at > NOW() - INTERVAL '1 hour' AND message_id > 999999`,
		);
		await query(
			`DELETE FROM roadmap.message_ledger WHERE created_at > NOW() - INTERVAL '1 hour' AND id > 999999`,
		);
	});

	it("AC-2: routes terminal failure to DLQ when escalated_at + reminder_sent_at + timeout_at + 30min expired", async () => {
		// Create synthetic message
		const msgResult = await query<{ id: string }>(
			`INSERT INTO roadmap.message_ledger
			 (from_agent, to_agent, channel, message_type, message_content, thread_id)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id`,
			[
				"test-sender",
				"test-recipient",
				"direct",
				"text",
				JSON.stringify({ test: "payload" }),
				1, // thread_id
			],
		);

		const messageId = msgResult.rows[0].id;

		// Create tracker row with both escalated_at and reminder_sent_at set
		// timeout_at is 35 minutes in the past to exceed the 30-minute threshold
		const mttResult = await query<{ id: string }>(
			`INSERT INTO roadmap.message_timeout_tracking
			 (message_id, timeout_at, escalation_recipient, escalated_at, reminder_sent_at)
			 VALUES ($1, NOW() - INTERVAL '35 minutes', $2, NOW() - INTERVAL '34 minutes', NOW() - INTERVAL '33 minutes')
			 RETURNING id`,
			[messageId, "operator"],
		);

		const mttId = mttResult.rows[0].id;

		// Verify tracker row has no final_outcome yet
		const beforeUpdate = await query<{ final_outcome: string | null }>(
			`SELECT final_outcome FROM roadmap.message_timeout_tracking WHERE id = $1`,
			[mttId],
		);
		expect(beforeUpdate.rows[0].final_outcome).toBeNull();

		// Run the DLQ-enqueue pass
		await runTimeoutSweep(db);

		// Assert DLQ row was created
		const dlqRows = await query<{
			original_message_id: string;
			failure_reason: string;
			from_agent: string;
			to_agent: string | null;
		}>(
			`SELECT original_message_id, failure_reason, from_agent, to_agent
			 FROM roadmap.dead_letter_queue
			 WHERE original_message_id = $1`,
			[messageId],
		);

		expect(dlqRows.rows.length).toBe(1);
		expect(dlqRows.rows[0].original_message_id).toBe(messageId);
		expect(dlqRows.rows[0].failure_reason).toBe("timeout_after_retries");
		expect(dlqRows.rows[0].from_agent).toBe("test-sender");
		expect(dlqRows.rows[0].to_agent).toBe("test-recipient");

		// Assert tracker row was updated with final_outcome
		const afterUpdate = await query<{
			final_outcome: string;
			resolved_at: string | null;
		}>(
			`SELECT final_outcome, resolved_at FROM roadmap.message_timeout_tracking WHERE id = $1`,
			[mttId],
		);

		expect(afterUpdate.rows[0].final_outcome).toBe("dead_lettered");
		expect(afterUpdate.rows[0].resolved_at).not.toBeNull();
	});

	it("AC-4: skips read messages and does not dead-letter them", async () => {
		// Create message that has been read
		const msgResult = await query<{ id: string }>(
			`INSERT INTO roadmap.message_ledger
			 (from_agent, to_agent, channel, message_type, message_content, thread_id, read_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW())
			 RETURNING id`,
			[
				"test-sender-read",
				"test-recipient-read",
				"direct",
				"text",
				JSON.stringify({ test: "read-payload" }),
				1,
			],
		);

		const messageId = msgResult.rows[0].id;

		// Create tracker row with terminal conditions
		await query(
			`INSERT INTO roadmap.message_timeout_tracking
			 (message_id, timeout_at, escalation_recipient, escalated_at, reminder_sent_at)
			 VALUES ($1, NOW() - INTERVAL '35 minutes', $2, NOW() - INTERVAL '34 minutes', NOW() - INTERVAL '33 minutes')`,
			[messageId, "operator"],
		);

		// Count DLQ rows before
		const beforeCount = await query<{ count: string }>(
			`SELECT COUNT(*) as count FROM roadmap.dead_letter_queue WHERE original_message_id = $1`,
			[messageId],
		);

		const before = Number(beforeCount.rows[0].count);

		// Run the DLQ-enqueue pass
		await runTimeoutSweep(db);

		// Count DLQ rows after (should be unchanged)
		const afterCount = await query<{ count: string }>(
			`SELECT COUNT(*) as count FROM roadmap.dead_letter_queue WHERE original_message_id = $1`,
			[messageId],
		);

		const after = Number(afterCount.rows[0].count);
		expect(after).toBe(before); // No new row inserted
	});

	it("AC-3: emits pg_notify on DLQ landing", async () => {
		const notifications: string[] = [];

		// Listen for dlq_landing notifications
		const client = await db.connect();
		try {
			await client.query("LISTEN dlq_landing");

			client.on("notification", (msg) => {
				if (msg.channel === "dlq_landing") {
					notifications.push(msg.payload);
				}
			});

			// Create synthetic message
			const msgResult = await query<{ id: string }>(
				`INSERT INTO roadmap.message_ledger
				 (from_agent, to_agent, channel, message_type, message_content, thread_id)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING id`,
				[
					"test-notif-sender",
					"test-notif-recipient",
					"direct",
					"text",
					JSON.stringify({ test: "notify-payload" }),
					1,
				],
			);

			const messageId = msgResult.rows[0].id;

			// Create tracker row
			await query(
				`INSERT INTO roadmap.message_timeout_tracking
				 (message_id, timeout_at, escalation_recipient, escalated_at, reminder_sent_at)
				 VALUES ($1, NOW() - INTERVAL '35 minutes', $2, NOW() - INTERVAL '34 minutes', NOW() - INTERVAL '33 minutes')`,
				[messageId, "operator"],
			);

			// Run timeout sweep
			await runTimeoutSweep(db);

			// Wait a bit for notification to arrive
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Check that notification was received
			expect(notifications.length).toBeGreaterThan(0);

			// Parse and verify notification payload
			const payload = JSON.parse(notifications[0]);
			expect(payload).toHaveProperty("dlq_id");
			expect(payload).toHaveProperty("message_id");
		} finally {
			await client.query("UNLISTEN dlq_landing");
			client.release();
		}
	});

	it("does not process messages that do not meet terminal failure criteria", async () => {
		// Create message without reminder_sent_at (not terminal)
		const msgResult = await query<{ id: string }>(
			`INSERT INTO roadmap.message_ledger
			 (from_agent, to_agent, channel, message_type, message_content, thread_id)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id`,
			[
				"test-non-term",
				"test-non-term-rec",
				"direct",
				"text",
				JSON.stringify({ test: "non-terminal" }),
				1,
			],
		);

		const messageId = msgResult.rows[0].id;

		// Create tracker row WITHOUT reminder_sent_at (doesn't meet terminal criteria)
		const mttResult = await query<{ id: string }>(
			`INSERT INTO roadmap.message_timeout_tracking
			 (message_id, timeout_at, escalation_recipient, escalated_at)
			 VALUES ($1, NOW() - INTERVAL '35 minutes', $2, NOW())
			 RETURNING id`,
			[messageId, "operator"],
		);

		// Run timeout sweep
		await runTimeoutSweep(db);

		// Assert no DLQ row was created
		const dlqRows = await query<{ id: string }>(
			`SELECT id FROM roadmap.dead_letter_queue WHERE original_message_id = $1`,
			[messageId],
		);

		expect(dlqRows.rows.length).toBe(0);
	});
});
