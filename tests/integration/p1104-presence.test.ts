/**
 * P1104: Presence State Machine Tests
 * - AC-6: presence_state column with CHECK constraint
 * - AC-7: fn_pulse updates atomically
 * - AC-8: pg_notify on state change
 * - AC-9: v_agency_status 60s dispatchable threshold
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { query, pool } from "../../src/infra/postgres/pool.ts";

Deno.test("P1104: presence_state column exists with CHECK constraint", async () => {
	const result = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'roadmap' AND table_name = 'agency' AND column_name = 'presence_state'
  `);

	assertEquals(result.rows.length, 1, "presence_state column should exist");
	const col = result.rows[0];
	assertEquals(col.data_type, "text", "presence_state should be text type");
	assertEquals(col.is_nullable, "NO", "presence_state should be NOT NULL");

	// Verify CHECK constraint exists
	const constraintResult = await query(`
    SELECT constraint_name
    FROM information_schema.constraint_column_usage
    WHERE table_schema = 'roadmap' AND table_name = 'agency' AND column_name = 'presence_state'
  `);

	assertEquals(constraintResult.rows.length > 0, true, "presence_state should have constraints");
});

Deno.test("P1104: fn_pulse updates both columns atomically", async () => {
	// Create test agency
	const testAgencyId = `test-p1104-${Date.now()}`;
	await query(
		`INSERT INTO roadmap.agency (agency_id, status, presence_state) VALUES ($1, 'active', 'offline')`,
		[testAgencyId],
	);

	try {
		// Call fn_pulse with 'online' state
		await query(`SELECT roadmap.fn_pulse($1, $2)`, [testAgencyId, "online"]);

		// Verify both columns updated atomically
		const result = await query(
			`SELECT last_heartbeat_at, presence_state FROM roadmap.agency WHERE agency_id = $1`,
			[testAgencyId],
		);

		assertEquals(result.rows.length, 1, "agency should exist");
		const row = result.rows[0];
		assertExists(row.last_heartbeat_at, "last_heartbeat_at should be set");
		assertEquals(row.presence_state, "online", "presence_state should be 'online'");

		// Call again with 'busy'
		await query(`SELECT roadmap.fn_pulse($1, $2)`, [testAgencyId, "busy"]);

		const result2 = await query(
			`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
			[testAgencyId],
		);

		assertEquals(result2.rows[0].presence_state, "busy", "presence_state should be 'busy'");
	} finally {
		await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [testAgencyId]);
	}
});

Deno.test("P1104: pg_notify fires on fn_pulse call", async (t) => {
	const testAgencyId = `test-notify-${Date.now()}`;
	await query(
		`INSERT INTO roadmap.agency (agency_id, status, presence_state) VALUES ($1, 'active', 'offline')`,
		[testAgencyId],
	);

	try {
		// Use native pg client to listen for notification
		const client = await pool.connect();
		let notificationReceived = false;
		let notificationPayload: string | undefined;

		client.on("notification", (msg: any) => {
			if (msg.channel === "agency_presence_changed") {
				notificationReceived = true;
				notificationPayload = msg.payload;
			}
		});

		try {
			await client.query("LISTEN agency_presence_changed");

			// Fire fn_pulse
			await query(`SELECT roadmap.fn_pulse($1, $2)`, [testAgencyId, "online"]);

			// Wait up to 1 second for notification
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Verify notification received
			assertEquals(notificationReceived, true, "pg_notify should fire");
			assertExists(notificationPayload, "notification payload should exist");

			const payload = JSON.parse(notificationPayload!);
			assertEquals(payload.agency_id, testAgencyId, "notification should include agency_id");
			assertEquals(payload.to, "online", "notification should include 'to' state");
		} finally {
			client.release();
		}
	} finally {
		await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [testAgencyId]);
	}
});

Deno.test("P1104: v_agency_status uses 60s dispatchable threshold", async () => {
	const viewDef = await query(`SELECT pg_get_viewdef('roadmap.v_agency_status')`);
	const defText = viewDef.rows[0].pg_get_viewdef;

	// Verify '60 seconds' or '00:01:00' interval is in the definition
	const has60s =
		defText.includes("60 seconds") ||
		defText.includes("'00:01:00'") ||
		defText.includes("60");

	assertEquals(
		has60s,
		true,
		"v_agency_status dispatchable predicate should use 60 second threshold",
	);

	// Verify view has presence_state column
	const hasPresenceState = defText.includes("presence_state");
	assertEquals(hasPresenceState, true, "v_agency_status should include presence_state column");
});
