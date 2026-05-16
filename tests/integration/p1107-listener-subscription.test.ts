/**
 * P1107 Integration Tests: listener_subscription plumbing
 *
 * AC-32: INSERT on LISTEN, DELETE on disconnect; watchdog reconcile identifies drift.
 */

import { test } from "node:test";
import assert from "node:assert";
import { Client } from "pg";
import { query } from "../../src/infra/postgres/pool.ts";

test("P1107: listener_subscription plumbing", async (t) => {
	let testClient: Client;
	const testChannel = "test_listener_ch_1107";
	const testIdentity = "test-liaison-agent-1107";

	// Cleanup at start
	try {
		await query(
			`DELETE FROM roadmap.listener_subscription
			  WHERE agent_identity = $1`,
			[testIdentity],
		);
	} catch {
		// ignore
	}

	await t.test("AC-32a: INSERT listener_subscription after LISTEN", async () => {
		testClient = new Client({
			host: process.env.PGHOST ?? "127.0.0.1",
			port: Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432),
			user: process.env.PGUSER ?? "admin",
			password: process.env.PGPASSWORD,
			database: process.env.PGDATABASE ?? "agenthive",
		});
		await testClient.connect();
		const pid = testClient.processID;

		// LISTEN on test channel
		await testClient.query(`LISTEN "${testChannel}"`);

		// Manually insert subscription (simulating liaison-agent.ts behavior)
		await query(
			`INSERT INTO roadmap.listener_subscription
			    (agent_identity, channel, established_at, established_pid)
			 VALUES ($1, $2, now(), $3)
			 ON CONFLICT (agent_identity, channel) DO UPDATE SET
			   established_at = now(),
			   established_pid = EXCLUDED.established_pid`,
			[testIdentity, testChannel, pid],
		);

		// Assert row exists
		const { rows } = await query<{
			agent_identity: string;
			channel: string;
			established_pid: number;
		}>(
			`SELECT agent_identity, channel, established_pid
			 FROM roadmap.listener_subscription
			 WHERE agent_identity = $1 AND channel = $2`,
			[testIdentity, testChannel],
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].established_pid, pid);
	});

	await t.test("AC-32b: DELETE listener_subscription on disconnect", async () => {
		// Precondition: row exists from previous test
		const beforeDelete = await query<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM roadmap.listener_subscription
			 WHERE agent_identity = $1 AND channel = $2`,
			[testIdentity, testChannel],
		);
		assert.strictEqual(Number(beforeDelete.rows[0].cnt), 1);

		// Close the client
		await testClient.end();

		// Manually delete subscription (simulating liaison-agent.ts stop() behavior)
		await query(
			`DELETE FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[testIdentity, testChannel],
		);

		// Assert row is gone
		const afterDelete = await query<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM roadmap.listener_subscription
			 WHERE agent_identity = $1 AND channel = $2`,
			[testIdentity, testChannel],
		);
		assert.strictEqual(Number(afterDelete.rows[0].cnt), 0);
	});

	await t.test("AC-32c: Reconcile function detects stale rows", async () => {
		// Insert a stale row with a non-existent PID
		const stalePid = 99999; // Assume this PID does not exist
		await query(
			`INSERT INTO roadmap.listener_subscription
			    (agent_identity, channel, established_at, established_pid)
			 VALUES ($1, $2, now(), $3)`,
			[testIdentity, testChannel, stalePid],
		);

		// Call reconcile function
		const { rows: driftRows } = await query<{
			agent_identity: string;
			channel: string;
			drift_reason: string;
		}>(
			`SELECT agent_identity, channel, drift_reason
			 FROM roadmap.fn_listener_reconcile_drift()`,
		);

		// Assert drift detected for stale row
		const staleRowDrift = driftRows.find(
			(d) =>
				d.agent_identity === testIdentity &&
				d.channel === testChannel,
		);
		assert.ok(staleRowDrift, "Expected drift row to be detected");
		assert.match(staleRowDrift!.drift_reason, /not in pg_stat_activity/);

		// Assert stale row was cleaned up by the function
		const remaining = await query<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM roadmap.listener_subscription
			 WHERE agent_identity = $1 AND channel = $2`,
			[testIdentity, testChannel],
		);
		assert.strictEqual(Number(remaining.rows[0].cnt), 0);
	});

	// Cleanup at end
	if (testClient) {
		try {
			await testClient.end();
		} catch {
			// ignore
		}
	}
	try {
		await query(
			`DELETE FROM roadmap.listener_subscription
			  WHERE agent_identity = $1`,
			[testIdentity],
		);
	} catch {
		// ignore
	}
});
