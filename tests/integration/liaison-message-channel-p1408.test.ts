/**
 * P1408 regression test: liaison-message channel split
 *
 * Verifies that fn_liaison_notify_new_message emits on 'liaison_message_<agency_id>'
 * (UUID payload), separate from fn_a2a_message_notify on 'msg_<to_agent>' (BIGINT payload).
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
		// This is a simpler assertion that just verifies the function definition
		// contains the correct channel literal, without requiring LISTEN infrastructure.
		const { rows } = await query(
			`SELECT pg_get_functiondef(oid) AS func_def
			 FROM pg_proc
			 WHERE proname = 'fn_liaison_notify_new_message'`,
		);

		assert.equal(rows.length, 1, "fn_liaison_notify_new_message should exist");
		const funcDef = rows[0].func_def;

		// Verify the function emits on 'liaison_message_' not 'msg_'
		assert.match(funcDef, /liaison_message_/, "function should emit to liaison_message_ channel");
		assert.doesNotMatch(funcDef, /'msg_' \|\| NEW\.agency_id/, "function should not emit to msg_ channel for liaison_message");
	});

	await t.test("fn_liaison_notify_new_message emits on 'liaison_message_<agency_id>' channel with UUID payload", async () => {
		const channelName = `liaison_message_${TEST_AGENCY_ID}`;
		const messageId = randomUUID();

		// Track notifications
		const notifications: string[] = [];

		// Set up listener
		listenClient = new Client();
		await listenClient.connect();

		await listenClient.query(`LISTEN "${channelName}"`);

		listenClient.on("notification", (msg) => {
			if (msg.channel === channelName) {
				notifications.push(msg.payload ?? "");
			}
		});

		// Insert a liaison_message row
		await query(
			`INSERT INTO roadmap.liaison_message
			  (agency_id, message_id, direction, kind, sequence)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_AGENCY_ID, messageId, "inbound", "generic", 1],
		);

		// Wait a bit for the notification to be delivered
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Verify notification was received
		assert(notifications.length > 0, "should receive notification on liaison_message_ channel");

		// Parse the payload as JSON
		const payload = JSON.parse(notifications[0]);

		// Verify payload contains the message_id as UUID (not bigint)
		assert.equal(payload.message_id, messageId, "payload should contain the message_id UUID");
		assert.equal(payload.direction, "inbound", "payload should contain direction");
		assert.equal(payload.kind, "generic", "payload should contain kind");
		assert.equal(payload.sequence, 1, "payload should contain sequence");

		// Clean up
		await listenClient.query(`UNLISTEN "${channelName}"`);

		// Clean up test data
		await query(
			`DELETE FROM roadmap.liaison_message WHERE agency_id = $1`,
			[TEST_AGENCY_ID],
		);

		if (listenClient) {
			await listenClient.end();
			listenClient = null;
		}
	});
});
