/**
 * P594 — agency schema function tests
 *
 * AC-2:  7 SECURITY DEFINER functions exist in agency schema
 * AC-5:  Dormancy sweep is cluster-safe (SKIP LOCKED + advisory lock)
 * AC-7:  Restart-loop guard: 3 consecutive heartbeat failures → paused
 * AC-15: is_dispatchable() returns FALSE when no active capacity row exists
 * AC-16: claim_capacity / release_capacity are atomic; concurrent test confirms exactly-2-of-3
 *
 * DB tests skipped when PGPASSWORD is not set.
 * Requires agency schema applied to the target DB.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const SKIP = !process.env.PGPASSWORD;
let agencySchemaExists = false;
const dbSkip = (name: string, fn: () => Promise<void>) =>
	it(name, async (t) => {
		if (SKIP || !agencySchemaExists) {
			t.skip("agency schema not installed or DB credentials absent");
			return;
		}
		await fn();
	});

const dbConfig = () => ({
	host:     process.env.PGHOST     ?? "127.0.0.1",
	port:     Number(process.env.PGPORT ?? 5432),
	user:     process.env.PGUSER     ?? "xiaomi",
	password: process.env.PGPASSWORD,
	database: process.env.PGDATABASE ?? "agenthive",
});

let pool: Pool;
const testAgencyId = "p594-fn-test-agency";
const testProviderId = "p594-fn-test-provider";

before(async () => {
	if (SKIP) return;
	pool = new Pool(dbConfig());

	const { rows: schemaRows } = await pool.query(
		"SELECT 1 FROM information_schema.schemata WHERE schema_name = 'agency'",
	);
	agencySchemaExists = schemaRows.length > 0;
	if (!agencySchemaExists) return;

	// Seed minimal fixtures: provider, principal, host, agency, session, capacity
	await pool.query(`
		INSERT INTO agency.agency_provider (provider_id, display_name, owner_did)
		VALUES ($1, 'P594 Function Test Provider', 'test:p594')
		ON CONFLICT (provider_id) DO NOTHING
	`, [testProviderId]);

	await pool.query(`
		INSERT INTO identity.principal (did, public_key, lifecycle_status, owner_did)
		VALUES ('did:agenthive:test:p594-fn', $1, 'active', 'test:p594')
		ON CONFLICT (did) DO NOTHING
	`, [Buffer.from('test-public-key-p594')]);

	// core.host: use an existing row or insert one
	await pool.query(`
		INSERT INTO core.host (host_name, role, owner_did)
		VALUES ('p594-test-host', 'agency', 'test:p594')
		ON CONFLICT (host_name) DO NOTHING
	`);

	await pool.query(`
		INSERT INTO agency.agency
		  (agency_id, display_name, provider_id, principal_did, host_id, owner_did)
		SELECT
		  $1, 'P594 Function Test Agency', $2,
		  'did:agenthive:test:p594-fn',
		  h.host_id,
		  'test:p594'
		FROM core.host h WHERE h.host_name = 'p594-test-host'
		ON CONFLICT (agency_id) DO NOTHING
	`, [testAgencyId, testProviderId]);
});

after(async () => {
	if (SKIP) return;
	// Clean up in dependency order
	if (!agencySchemaExists) { await pool.end(); return; }
	await pool.query(`DELETE FROM agency.agency_capacity  WHERE agency_id = $1`, [testAgencyId]);
	await pool.query(`DELETE FROM agency.agency_session   WHERE agency_id = $1`, [testAgencyId]);
	await pool.query(`DELETE FROM agency.agency           WHERE agency_id = $1`, [testAgencyId]);
	await pool.query(`DELETE FROM identity.principal      WHERE did = 'did:agenthive:test:p594-fn'`);
	await pool.query(`DELETE FROM agency.agency_provider  WHERE provider_id = $1`, [testProviderId]);
	await pool.query(`DELETE FROM core.host               WHERE host_name = 'p594-test-host'`);
	await pool.end();
});

// ─── AC-2: Functions exist ────────────────────────────────────────────────

describe("AC-2: SECURITY DEFINER functions in agency schema", () => {
	const expectedFunctions = [
		"is_dispatchable",
		"session_heartbeat",
		"list_stale_sessions",
		"mark_dormant",
		"mark_reconnecting",
		"claim_capacity",
		"release_capacity",
	];

	for (const fn of expectedFunctions) {
		dbSkip(`function agency.${fn} exists with SECURITY DEFINER`, async () => {
			const { rows } = await pool.query<{ proname: string; prosecdef: boolean }>(`
				SELECT p.proname, p.prosecdef
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = 'agency' AND p.proname = $1
			`, [fn]);
			assert.ok(rows.length >= 1, `agency.${fn} must exist`);
			assert.ok(rows[0].prosecdef, `agency.${fn} must be SECURITY DEFINER`);
		});
	}
});

// ─── AC-15: is_dispatchable returns FALSE without capacity row ─────────────

describe("AC-15: is_dispatchable() returns FALSE when no active capacity row", () => {
	dbSkip("is_dispatchable FALSE with active agency + active session but no capacity row", async () => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Open session, no capacity row
			await client.query(`
				INSERT INTO agency.agency_session
				  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
				VALUES ($1, 'active', now(), now(), 'test:p594')
			`, [testAgencyId]);

			// Confirm no active capacity row exists
			const { rows: capRows } = await client.query(`
				SELECT capacity_id FROM agency.agency_capacity
				WHERE agency_id = $1 AND lifecycle_status = 'active'
			`, [testAgencyId]);
			assert.equal(capRows.length, 0, "test fixture: no capacity row should exist");

			const { rows } = await client.query<{ is_dispatchable: boolean }>(
				"SELECT agency.is_dispatchable($1) AS is_dispatchable",
				[testAgencyId],
			);
			assert.equal(rows[0].is_dispatchable, false, "is_dispatchable must return FALSE when no capacity row");

			await client.query("ROLLBACK");
		} finally {
			client.release();
		}
	});
});

// ─── AC-16: claim_capacity / release_capacity atomic ops ──────────────────

describe("AC-16: claim_capacity and release_capacity are atomic", () => {
	dbSkip("3 concurrent callers with max_concurrent=2: exactly 2 return TRUE", async () => {
		const client = await pool.connect();
		try {
			// Seed capacity with max_concurrent=2
			await client.query(`
				INSERT INTO agency.agency_capacity
				  (agency_id, max_concurrent, current_load, owner_did)
				VALUES ($1, 2, 0, 'test:p594')
				ON CONFLICT DO NOTHING
			`, [testAgencyId]);

			// 3 concurrent callers
			const results = await Promise.all([
				pool.query<{ claim_capacity: boolean }>(
					"SELECT agency.claim_capacity($1) AS claim_capacity", [testAgencyId]),
				pool.query<{ claim_capacity: boolean }>(
					"SELECT agency.claim_capacity($1) AS claim_capacity", [testAgencyId]),
				pool.query<{ claim_capacity: boolean }>(
					"SELECT agency.claim_capacity($1) AS claim_capacity", [testAgencyId]),
			]);

			const trueCount = results.filter(r => r.rows[0].claim_capacity).length;
			assert.equal(trueCount, 2, "exactly 2 of 3 concurrent claim_capacity calls must return TRUE");

			// Verify current_load = 2
			const { rows } = await pool.query<{ current_load: number }>(`
				SELECT current_load FROM agency.agency_capacity
				WHERE agency_id = $1 AND lifecycle_status = 'active'
			`, [testAgencyId]);
			assert.equal(rows[0].current_load, 2, "current_load must be exactly 2 after 2 claims");

			// Release both; current_load should return to 0
			await pool.query("SELECT agency.release_capacity($1)", [testAgencyId]);
			await pool.query("SELECT agency.release_capacity($1)", [testAgencyId]);

			const { rows: after } = await pool.query<{ current_load: number }>(`
				SELECT current_load FROM agency.agency_capacity
				WHERE agency_id = $1 AND lifecycle_status = 'active'
			`, [testAgencyId]);
			assert.equal(after[0].current_load, 0, "current_load must return to 0 after both releases");
		} finally {
			// Clean up capacity for other tests
			await client.query("DELETE FROM agency.agency_capacity WHERE agency_id = $1", [testAgencyId]);
			client.release();
		}
	});

	dbSkip("release_capacity does not underflow below 0 (GREATEST floor)", async () => {
		// Seed capacity with current_load already 0
		await pool.query(`
			INSERT INTO agency.agency_capacity
			  (agency_id, max_concurrent, current_load, owner_did)
			VALUES ($1, 2, 0, 'test:p594')
			ON CONFLICT DO NOTHING
		`, [testAgencyId]);

		// Releasing when current_load=0 must not go negative
		await pool.query("SELECT agency.release_capacity($1)", [testAgencyId]);

		const { rows } = await pool.query<{ current_load: number }>(`
			SELECT current_load FROM agency.agency_capacity
			WHERE agency_id = $1 AND lifecycle_status = 'active'
		`, [testAgencyId]);
		assert.equal(rows[0].current_load, 0, "current_load must not go below 0 (GREATEST floor)");

		// Clean up
		await pool.query("DELETE FROM agency.agency_capacity WHERE agency_id = $1", [testAgencyId]);
	});
});

// ─── AC-7: Heartbeat failure count → paused ───────────────────────────────

describe("AC-7: 3 consecutive heartbeat failures → dormancy_state=paused", () => {
	dbSkip(
		"incrementing heartbeat_failure_count to 3 then setting dormancy_state=paused is supported",
		async () => {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");

				// Create active session
				const { rows: sessionRows } = await client.query<{ session_id: string }>(`
					INSERT INTO agency.agency_session
					  (agency_id, dormancy_state, heartbeat_failure_count, started_at, last_heartbeat_at, owner_did)
					VALUES ($1, 'active', 0, now(), now(), 'test:p594')
					RETURNING session_id
				`, [testAgencyId]);
				const sessionId = sessionRows[0].session_id;

				// Simulate 3 liaison boot loop heartbeat failures via direct UPDATE
				for (let i = 1; i <= 3; i++) {
					await client.query(`
						UPDATE agency.agency_session
						SET heartbeat_failure_count = heartbeat_failure_count + 1
						WHERE session_id = $1
					`, [sessionId]);
				}

				// Check count reached 3
				const { rows: countRows } = await client.query<{ heartbeat_failure_count: number }>(`
					SELECT heartbeat_failure_count FROM agency.agency_session WHERE session_id = $1
				`, [sessionId]);
				assert.equal(countRows[0].heartbeat_failure_count, 3, "heartbeat_failure_count must be 3");

				// Application sets dormancy_state to 'paused' after 3 failures
				await client.query(`
					UPDATE agency.agency_session
					SET dormancy_state = 'paused'
					WHERE session_id = $1 AND heartbeat_failure_count >= 3
				`, [sessionId]);

				const { rows: stateRows } = await client.query<{ dormancy_state: string }>(`
					SELECT dormancy_state FROM agency.agency_session WHERE session_id = $1
				`, [sessionId]);
				assert.equal(stateRows[0].dormancy_state, "paused", "dormancy_state must be paused after 3 failures");

				// session_heartbeat must be a no-op on paused sessions
				await client.query("SELECT agency.session_heartbeat($1, $2)", [sessionId, testAgencyId]);
				const { rows: afterHb } = await client.query<{ dormancy_state: string }>(`
					SELECT dormancy_state FROM agency.agency_session WHERE session_id = $1
				`, [sessionId]);
				assert.equal(afterHb[0].dormancy_state, "paused", "session_heartbeat must be no-op on paused session");

				await client.query("ROLLBACK");
			} finally {
				client.release();
			}
		},
	);
});

// ─── AC-5: Cluster-safe sweep (SKIP LOCKED + advisory lock) ───────────────

describe("AC-5: dormancy sweep is cluster-safe (SKIP LOCKED + advisory lock)", () => {
	dbSkip("4 concurrent orchestrator sweeps: exactly-one mark_dormant per stale session", async () => {
		const client = await pool.connect();
		let staleSessionId: string;

		try {
			// Seed a stale session (last_heartbeat_at 10 minutes ago)
			const { rows } = await client.query<{ session_id: string }>(`
				INSERT INTO agency.agency_session
				  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
				VALUES ($1, 'active', now() - interval '10 minutes', now() - interval '10 minutes', 'test:p594')
				RETURNING session_id
			`, [testAgencyId]);
			staleSessionId = rows[0].session_id;
		} finally {
			client.release();
		}

		// Simulate 4 concurrent orchestrators running the sweep with SKIP LOCKED
		const lockId = `hashtext_agency_dormancy_sweep`;
		const sweepFn = async (poolInst: Pool): Promise<boolean> => {
			const c = await poolInst.connect();
			try {
				await c.query("BEGIN");
				// Try to acquire session-level advisory lock (coordinator election)
				const { rows: lockRows } = await c.query<{ acquired: boolean }>(`
					SELECT pg_try_advisory_lock(
					  hashtext('agency_dormancy_sweep')::int4,
					  0::int4
					) AS acquired
				`);
				if (!lockRows[0].acquired) {
					await c.query("ROLLBACK");
					return false;
				}

				// SKIP LOCKED sweep — claim stale sessions
				const { rows: staleRows } = await c.query<{ session_id: string }>(`
					SELECT session_id FROM agency.agency_session
					WHERE dormancy_state = 'active'
					  AND ended_at IS NULL
					  AND last_heartbeat_at < now() - interval '60 seconds'
					  AND session_id = $1
					FOR UPDATE SKIP LOCKED
				`, [staleSessionId]);

				let transitioned = false;
				for (const row of staleRows) {
					await c.query("SELECT agency.mark_dormant($1, $2)", [row.session_id, "stale_timeout"]);
					transitioned = true;
				}

				// Release session-level advisory lock
				await c.query(`SELECT pg_advisory_unlock(hashtext('agency_dormancy_sweep')::int4, 0::int4)`);
				await c.query("COMMIT");
				return transitioned;
			} catch {
				await c.query("ROLLBACK");
				return false;
			} finally {
				c.release();
			}
		};

		// Create 4 independent pool connections to simulate 4 orchestrator instances
		const pools = Array.from({ length: 4 }, () => new Pool(dbConfig()));
		const results = await Promise.all(pools.map(p => sweepFn(p)));
		await Promise.all(pools.map(p => p.end()));

		const transitionCount = results.filter(Boolean).length;
		assert.equal(transitionCount, 1, "exactly one orchestrator must mark the stale session dormant");

		// Confirm the session is now dormant
		const { rows: finalState } = await pool.query<{ dormancy_state: string }>(`
			SELECT dormancy_state FROM agency.agency_session WHERE session_id = $1
		`, [staleSessionId]);
		assert.equal(finalState[0].dormancy_state, "dormant", "stale session must be dormant after sweep");

		// Cleanup
		await pool.query("DELETE FROM agency.agency_session WHERE session_id = $1", [staleSessionId]);
	});
});
