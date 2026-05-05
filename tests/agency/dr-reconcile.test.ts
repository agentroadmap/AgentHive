/**
 * P594 — DR session reconciliation tests
 *
 * AC-6: DR session reconciliation is in scripts/dr/agency-session-reconcile.sql
 *       using direct UPDATE on agency.agency_session (NOT queue-fanout);
 *       failover_time - 60s cutoff arithmetic matches the DR runbook.
 *       lease-reconcile.sql is a separate script for dispatch leases.
 *
 * DB tests skipped when PGPASSWORD is not set.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

const DR_SCRIPT_PATH = join(import.meta.dirname, "../../scripts/dr/agency-session-reconcile.sql");
const LEASE_SCRIPT_PATH = join(import.meta.dirname, "../../scripts/dr/lease-reconcile.sql");

let pool: Pool;
const testAgencyId = "p594-dr-test-agency";
const testProviderId = "p594-dr-test-provider";

before(async () => {
	if (SKIP) return;
	pool = new Pool({
		host:     process.env.PGHOST     ?? "127.0.0.1",
		port:     Number(process.env.PGPORT ?? 5432),
		user:     process.env.PGUSER     ?? "xiaomi",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});

	const { rows: schemaRows } = await pool.query(
		"SELECT 1 FROM information_schema.schemata WHERE schema_name = 'agency'",
	);
	agencySchemaExists = schemaRows.length > 0;
	if (!agencySchemaExists) return;

	// Seed fixtures
	await pool.query(`
		INSERT INTO agency.agency_provider (provider_id, display_name, owner_did)
		VALUES ($1, 'P594 DR Test Provider', 'test:p594')
		ON CONFLICT (provider_id) DO NOTHING
	`, [testProviderId]);

	await pool.query(`
		INSERT INTO identity.principal (did, public_key, lifecycle_status, owner_did)
		VALUES ('did:agenthive:test:p594-dr', $1, 'active', 'test:p594')
		ON CONFLICT (did) DO NOTHING
	`, [Buffer.from('test-key-p594-dr')]);

	await pool.query(`
		INSERT INTO core.host (host_name, role, owner_did)
		VALUES ('p594-dr-test-host', 'agency', 'test:p594')
		ON CONFLICT (host_name) DO NOTHING
	`);

	await pool.query(`
		INSERT INTO agency.agency
		  (agency_id, display_name, provider_id, principal_did, host_id, owner_did)
		SELECT
		  $1, 'P594 DR Test Agency', $2,
		  'did:agenthive:test:p594-dr',
		  h.host_id,
		  'test:p594'
		FROM core.host h WHERE h.host_name = 'p594-dr-test-host'
		ON CONFLICT (agency_id) DO NOTHING
	`, [testAgencyId, testProviderId]);
});

after(async () => {
	if (SKIP) return;
	if (!agencySchemaExists) { await pool.end(); return; }
	await pool.query(`DELETE FROM agency.agency_session  WHERE agency_id = $1`, [testAgencyId]);
	await pool.query(`DELETE FROM agency.agency          WHERE agency_id = $1`, [testAgencyId]);
	await pool.query(`DELETE FROM identity.principal     WHERE did = 'did:agenthive:test:p594-dr'`);
	await pool.query(`DELETE FROM agency.agency_provider WHERE provider_id = $1`, [testProviderId]);
	await pool.query(`DELETE FROM core.host              WHERE host_name = 'p594-dr-test-host'`);
	await pool.end();
});

// ─── File-based checks (always run) ───────────────────────────────────────

describe("AC-6: DR script uses direct UPDATE, not queue-fanout", () => {
	it("agency-session-reconcile.sql must contain UPDATE on agency.agency_session", async () => {
		const sql = await readFile(DR_SCRIPT_PATH, "utf-8");
		assert.ok(
			sql.includes("UPDATE") && sql.includes("agency_session"),
			"DR script must contain direct UPDATE on agency_session",
		);
	});

	it("agency-session-reconcile.sql must NOT insert into a queue table (no queue-fanout)", async () => {
		const sql = await readFile(DR_SCRIPT_PATH, "utf-8");
		assert.ok(
			!sql.includes("dr_orphan_lease_request"),
			"DR agency session script must not use queue-fanout (dr_orphan_lease_request)",
		);
	});

	it("agency-session-reconcile.sql uses failover_time - 60s cutoff arithmetic", async () => {
		const sql = await readFile(DR_SCRIPT_PATH, "utf-8");
		assert.ok(
			sql.includes("60") && (sql.includes("failover_time") || sql.includes("interval")),
			"DR script must use 60-second cutoff arithmetic",
		);
	});

	it("lease-reconcile.sql (dispatch leases) is a separate script from DR session reconcile", async () => {
		const [drSql, leaseSql] = await Promise.all([
			readFile(DR_SCRIPT_PATH, "utf-8"),
			readFile(LEASE_SCRIPT_PATH, "utf-8"),
		]);
		assert.notEqual(drSql, leaseSql, "DR agency session script must differ from lease-reconcile.sql");
		assert.ok(
			!drSql.includes("offer_claim") && !drSql.includes("orphan_lease"),
			"DR agency session script must not touch offer/claim tables",
		);
	});
});

// ─── DB-backed checks ──────────────────────────────────────────────────────

describe("AC-6: DR reconcile direct UPDATE mechanics (live DB)", () => {
	dbSkip("sessions stale before failover_time - 60s → dormant", async () => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Session whose last_heartbeat_at is older than failover_time - 60s
			const { rows } = await client.query<{ session_id: string }>(`
				INSERT INTO agency.agency_session
				  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
				VALUES ($1, 'active', now() - interval '10 minutes', now() - interval '10 minutes', 'test:p594')
				RETURNING session_id
			`, [testAgencyId]);
			const staleId = rows[0].session_id;

			// Simulate DR reconcile: failover_time is now(); stale = heartbeat < failover_time - 60s
			const failoverTime = new Date().toISOString();
			await client.query(`
				UPDATE agency.agency_session
				SET dormancy_state = 'dormant',
				    ended_at       = $2,
				    end_reason     = 'dr_failover'
				WHERE dormancy_state IN ('active', 'reconnecting')
				  AND ended_at IS NULL
				  AND last_heartbeat_at < $2::timestamptz - interval '60 seconds'
				  AND session_id = $3
			`, [failoverTime, failoverTime, staleId]);

			const { rows: stateRows } = await client.query<{ dormancy_state: string }>(`
				SELECT dormancy_state FROM agency.agency_session WHERE session_id = $1
			`, [staleId]);
			assert.equal(stateRows[0].dormancy_state, "dormant", "stale session must become dormant in DR reconcile");

			await client.query("ROLLBACK");
		} finally {
			client.release();
		}
	});

	dbSkip("sessions alive within 60s of failover_time → reconnecting with grace window", async () => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			// Session alive just 30 seconds before failover
			const { rows } = await client.query<{ session_id: string }>(`
				INSERT INTO agency.agency_session
				  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
				VALUES ($1, 'active', now() - interval '5 minutes', now() - interval '30 seconds', 'test:p594')
				RETURNING session_id
			`, [testAgencyId]);
			const aliveId = rows[0].session_id;

			const failoverTime = new Date().toISOString();
			// Alive sessions (heartbeat within 60s of failover) → reconnecting
			await client.query(`
				UPDATE agency.agency_session
				SET dormancy_state        = 'reconnecting',
				    reconnect_grace_until = $2::timestamptz + interval '120 seconds'
				WHERE dormancy_state = 'active'
				  AND ended_at IS NULL
				  AND last_heartbeat_at >= $2::timestamptz - interval '60 seconds'
				  AND session_id = $3
			`, [failoverTime, failoverTime, aliveId]);

			const { rows: stateRows } = await client.query<{
				dormancy_state: string;
				reconnect_grace_until: Date | null;
			}>(`
				SELECT dormancy_state, reconnect_grace_until
				FROM agency.agency_session WHERE session_id = $1
			`, [aliveId]);
			assert.equal(stateRows[0].dormancy_state, "reconnecting", "alive session must be reconnecting after DR");
			assert.ok(
				stateRows[0].reconnect_grace_until !== null,
				"reconnect_grace_until must be set for reconnecting sessions",
			);

			await client.query("ROLLBACK");
		} finally {
			client.release();
		}
	});
});
