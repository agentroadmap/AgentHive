/**
 * P1408 regression test: liaison-message channel split
 *
 * Verifies that fn_liaison_notify_new_message emits on 'liaison_message_<agency_id>'
 * (UUID payload), separate from fn_a2a_message_notify on 'msg_<to_agent>' (BIGINT payload).
 *
 * Schema notes (verified against live DB 2026-05-27):
 *  - roadmap.liaison_message NOT NULL: agency_id, sequence, direction, kind,
 *    correlation_id (uuid), payload (jsonb, default '{}'), signed_at (timestamptz),
 *    signature (text).
 *  - direction CHECK: must be 'orchestrator->liaison' or 'liaison->orchestrator'.
 *  - FK: agency_id → roadmap.agency(agency_id) ON DELETE CASCADE.
 */

import { test } from "node:test";
import assert from "node:assert";
import { Client } from "pg";
import { query } from "../../src/infra/postgres/pool.js";
import { randomUUID } from "node:crypto";

const TEST_AGENCY_ID = "test-agency-p1408";

test("P1408: liaison-message channel split", async (t) => {
	let listenClient: Client | null = null;

	await t.test("pg_get_functiondef confirms fn_liaison_notify_new_message uses 'liaison_message_' prefix", async () => {
		const { rows } = await query(
			`SELECT pg_get_functiondef(oid) AS func_def
			 FROM pg_proc
			 WHERE proname = 'fn_liaison_notify_new_message'`,
		);

		assert.equal(rows.length, 1, "fn_liaison_notify_new_message should exist");
		const funcDef = rows[0].func_def;

		assert.match(funcDef, /liaison_message_/, "function should emit to liaison_message_ channel");
		assert.doesNotMatch(funcDef, /'msg_' \|\| NEW\.agency_id/, "function should not emit to msg_ channel for liaison_message");
	});

	await t.test("fn_liaison_notify_new_message emits on 'liaison_message_<agency_id>' channel with UUID payload", async () => {
		const channelName = `liaison_message_${TEST_AGENCY_ID}`;
		const messageId = randomUUID();
		const correlationId = randomUUID();

		// Pre-create FK target row in roadmap.agency. ON CONFLICT DO NOTHING so
		// re-runs don't error if the test row already exists from a prior run.
		await query(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, capability_tags, status, presence_state)
			 VALUES ($1, $1, 'test', 'bot', ARRAY[]::text[], 'active', 'offline')
			 ON CONFLICT (agency_id) DO NOTHING`,
			[TEST_AGENCY_ID],
		);

		const notifications: string[] = [];
		listenClient = new Client();
		await listenClient.connect();
		await listenClient.query(`LISTEN "${channelName}"`);
		listenClient.on("notification", (msg) => {
			if (msg.channel === channelName) {
				notifications.push(msg.payload ?? "");
			}
		});

		// Insert with all required NOT NULL columns, valid direction enum,
		// and explicit message_id so we can assert it round-trips.
		await query(
			`INSERT INTO roadmap.liaison_message
			   (message_id, agency_id, sequence, direction, kind,
			    correlation_id, payload, signed_at, signature)
			 VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now(), $7)`,
			[
				messageId,
				TEST_AGENCY_ID,
				1,
				"orchestrator->liaison",
				"generic",
				correlationId,
				"test-sig-p1408",
			],
		);

		await new Promise((resolve) => setTimeout(resolve, 100));

		assert(notifications.length > 0, "should receive notification on liaison_message_ channel");

		const payload = JSON.parse(notifications[0]);
		assert.equal(payload.message_id, messageId, "payload message_id should be the inserted UUID");
		assert.equal(payload.direction, "orchestrator->liaison");
		assert.equal(payload.kind, "generic");
		assert.equal(Number(payload.sequence), 1);

		await listenClient.query(`UNLISTEN "${channelName}"`);

		// Cleanup: liaison_message first (no cascading delete from agency unless agency goes),
		// then agency. ON DELETE CASCADE on the FK means deleting the agency would also
		// drop the message row, but we keep order explicit for readability.
		await query(`DELETE FROM roadmap.liaison_message WHERE agency_id = $1`, [TEST_AGENCY_ID]);
		await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [TEST_AGENCY_ID]);

		if (listenClient) {
			await listenClient.end();
			listenClient = null;
		}
	});
});
