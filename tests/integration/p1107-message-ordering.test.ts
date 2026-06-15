/**
 * P1107 Integration Tests: Message ordering within a correlation context
 *
 * AC-1: 100 sequential messages with same correlation_id are retrieved in
 * strictly ascending id order with no gaps.
 */

import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { query } from "../../src/infra/postgres/pool.ts";

test("P1107 AC-1: message ordering within correlation context", async (t) => {
	const correlationId = randomUUID();
	const fromAgent = "p1107-test-sender";
	const toAgent = "p1107-test-receiver";
	const MESSAGE_COUNT = 100;

	// Ensure test agents exist
	await query(
		`INSERT INTO roadmap.agent_registry (agent_identity, agent_type)
		 VALUES ($1, 'llm'), ($2, 'llm')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[fromAgent, toAgent],
	);

	let insertedIds: number[] = [];

	await t.test("AC-1a: insert 100 sequential messages with same correlation_id", async () => {
		for (let i = 0; i < MESSAGE_COUNT; i++) {
			const result = await query<{ id: number }>(
				`INSERT INTO roadmap.message_ledger
				  (from_agent, to_agent, message_type, message_content, correlation_id)
				 VALUES ($1, $2, 'text', $3, $4)
				 RETURNING id`,
				[fromAgent, toAgent, `message ${i + 1} of ${MESSAGE_COUNT}`, correlationId],
			);
			insertedIds.push(result.rows[0].id);
		}
		assert.strictEqual(insertedIds.length, MESSAGE_COUNT);
	});

	await t.test("AC-1b: retrieved in strictly ascending id order with no gaps", async () => {
		const { rows } = await query<{ msg_count: string; id_span: string }>(
			`SELECT COUNT(*) AS msg_count, MAX(id) - MIN(id) AS id_span
			 FROM roadmap.message_ledger
			 WHERE correlation_id = $1`,
			[correlationId],
		);
		assert.strictEqual(Number(rows[0].msg_count), MESSAGE_COUNT, "must have exactly 100 messages");
		assert.strictEqual(Number(rows[0].id_span), MESSAGE_COUNT - 1, "ids must be contiguous (no gaps)");
	});

	await t.test("AC-1c: ORDER BY id returns ascending sequence", async () => {
		const { rows } = await query<{ id: number }>(
			`SELECT id FROM roadmap.message_ledger
			 WHERE correlation_id = $1
			 ORDER BY id ASC`,
			[correlationId],
		);
		assert.strictEqual(rows.length, MESSAGE_COUNT);
		for (let i = 1; i < rows.length; i++) {
			assert.ok(rows[i].id > rows[i - 1].id, `row ${i} id must be greater than row ${i - 1} id`);
		}
	});

	// Cleanup
	await query(
		`DELETE FROM roadmap.message_ledger WHERE correlation_id = $1`,
		[correlationId],
	);
});
