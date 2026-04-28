/**
 * P594 — migration script structural and execution tests
 *
 * AC-8:  Migration is idempotent (ON CONFLICT DO NOTHING throughout)
 * AC-12: Step 4 seeds an open agency_session for every migrated agency that lacks one
 * AC-13: Step 0 seeds core.host with role+owner_did before agency INSERT
 * AC-14: Step 2b seeds default agency_capacity for every migrated agency
 * AC-17: Step 0 INSERT includes role='agency' and owner_did='system:migration' + ON CONFLICT DO NOTHING
 *
 * File-based tests always run.
 * DB-backed tests skipped when PGPASSWORD is not set.
 * Requires the P594 migration to have been applied to the target DB.
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

const MIGRATION_PATH = join(
	import.meta.dirname,
	"../../scripts/migrations/062-p594-agency-schema.sql",
);

let pool: Pool;
const testProviderId  = "p594-mig-test-provider";
const testAgencyIdA   = "p594-mig-test-agency-a";
const testAgencyIdB   = "p594-mig-test-agency-b";

before(async () => {
	if (SKIP) return;
	pool = new Pool({
		host:     process.env.PGHOST     ?? "127.0.0.1",
		port:     Number(process.env.PGPORT ?? 5432),
		user:     process.env.PGUSER     ?? "xiaomi",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
	const { rows } = await pool.query(
		"SELECT 1 FROM information_schema.schemata WHERE schema_name = 'agency'",
	);
	agencySchemaExists = rows.length > 0;
});

after(async () => {
	if (SKIP) return;
	if (!agencySchemaExists) { await pool.end(); return; }
	await pool.query(`DELETE FROM agency.agency_capacity  WHERE agency_id IN ($1,$2)`, [testAgencyIdA, testAgencyIdB]);
	await pool.query(`DELETE FROM agency.agency_session   WHERE agency_id IN ($1,$2)`, [testAgencyIdA, testAgencyIdB]);
	await pool.query(`DELETE FROM agency.agency           WHERE agency_id IN ($1,$2)`, [testAgencyIdA, testAgencyIdB]);
	await pool.query(`DELETE FROM identity.principal      WHERE did IN ('did:agenthive:spawn:p594-mig-test-agency-a','did:agenthive:spawn:p594-mig-test-agency-b')`);
	await pool.query(`DELETE FROM agency.agency_provider  WHERE provider_id = $1`, [testProviderId]);
	await pool.query(`DELETE FROM core.host               WHERE host_name = 'p594-mig-test-host'`);
	await pool.end();
});

// ─── File-based checks (always run) ───────────────────────────────────────

describe("AC-8: migration file uses ON CONFLICT DO NOTHING (idempotent)", () => {
	it("every INSERT in migration file uses ON CONFLICT … DO NOTHING or equivalent", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		// Every INSERT block should have ON CONFLICT
		const insertCount = (sql.match(/^INSERT INTO/gmi) ?? []).length;
		const conflictCount = (sql.match(/ON CONFLICT/gi) ?? []).length;
		assert.ok(insertCount > 0, "migration must have at least one INSERT");
		assert.ok(
			conflictCount >= insertCount,
			`every INSERT must have ON CONFLICT clause (INSERTs: ${insertCount}, ON CONFLICT: ${conflictCount})`,
		);
	});
});

describe("AC-13: Step 0 seeds core.host with role + owner_did", () => {
	it("migration must INSERT core.host with role and owner_did fields", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		assert.ok(
			sql.includes("core.host") && sql.includes("role") && sql.includes("owner_did"),
			"Step 0 must INSERT into core.host with role and owner_did",
		);
	});
});

describe("AC-17: Step 0 uses role='agency' and owner_did='system:migration'", () => {
	it("migration must supply role='agency' and owner_did='system:migration' in core.host INSERT", async () => {
		const sql = await readFile(MIGRATION_PATH, "utf-8");
		assert.ok(
			sql.includes("'agency'") && sql.includes("'system:migration'"),
			"Step 0 must supply role='agency' and owner_did='system:migration'",
		);
		assert.ok(
			sql.includes("ON CONFLICT (host_name) DO NOTHING"),
			"Step 0 must have ON CONFLICT (host_name) DO NOTHING for core.host",
		);
	});
});

// ─── DB-backed checks ──────────────────────────────────────────────────────

describe("AC-13: Step 0 core.host seeding (live DB)", () => {
	dbSkip("Step 0 inserts missing host rows without NOT NULL violation", async () => {
		// Simulate the Step 0 INSERT directly (as migration would)
		await pool.query(`
			INSERT INTO core.host (host_name, role, owner_did)
			VALUES ('p594-mig-test-host', 'agency', 'system:migration')
			ON CONFLICT (host_name) DO NOTHING
		`);

		const { rows } = await pool.query<{ role: string; owner_did: string }>(`
			SELECT role, owner_did FROM core.host WHERE host_name = 'p594-mig-test-host'
		`);
		assert.equal(rows.length, 1, "Step 0 must insert the host row");
		assert.equal(rows[0].role, "agency", "role must be 'agency'");
		assert.equal(rows[0].owner_did, "system:migration", "owner_did must be 'system:migration'");
	});

	dbSkip("Step 0 does not error when host already exists (ON CONFLICT idempotent)", async () => {
		// Run again — must not throw
		await pool.query(`
			INSERT INTO core.host (host_name, role, owner_did)
			VALUES ('p594-mig-test-host', 'agency', 'system:migration')
			ON CONFLICT (host_name) DO NOTHING
		`);
		// If we got here, no exception was thrown
		const { rows } = await pool.query<{ host_name: string }>(`
			SELECT host_name FROM core.host WHERE host_name = 'p594-mig-test-host'
		`);
		assert.equal(rows.length, 1, "duplicate Step 0 INSERT must not create a second row");
	});
});

describe("AC-8 + AC-12 + AC-14: full migration idempotency on test agencies (live DB)", () => {
	dbSkip("after migration Steps 1–4, every agency has an open session and active capacity row", async () => {
		// Manually run the relevant parts of the migration for test agencies
		await pool.query(`
			INSERT INTO agency.agency_provider (provider_id, display_name, owner_did)
			VALUES ($1, 'P594 Migration Test Provider', 'test:p594')
			ON CONFLICT (provider_id) DO NOTHING
		`, [testProviderId]);

		// Step 1.5: seed placeholder principals
		for (const id of [testAgencyIdA, testAgencyIdB]) {
			await pool.query(`
				INSERT INTO identity.principal (did, public_key, lifecycle_status, owner_did)
				VALUES ($1, $2, 'active', 'system:migration')
				ON CONFLICT (did) DO NOTHING
			`, [`did:agenthive:spawn:${id}`, Buffer.from(`placeholder-${id}`)]);
		}

		// Step 2: Insert agency rows
		for (const id of [testAgencyIdA, testAgencyIdB]) {
			await pool.query(`
				INSERT INTO agency.agency
				  (agency_id, display_name, provider_id, principal_did, host_id, owner_did)
				SELECT $1, $1, $2,
				  $3,
				  h.host_id,
				  'system:migration'
				FROM core.host h WHERE h.host_name = 'p594-mig-test-host'
				ON CONFLICT (agency_id) DO NOTHING
			`, [id, testProviderId, `did:agenthive:spawn:${id}`]);
		}

		// Step 2b: Seed capacity
		await pool.query(`
			INSERT INTO agency.agency_capacity (agency_id, max_concurrent, current_load, owner_did)
			SELECT agency_id, 1, 0, 'system:migration'
			FROM agency.agency
			WHERE agency_id IN ($1, $2)
			  AND NOT EXISTS (
			    SELECT 1 FROM agency.agency_capacity c
			    WHERE c.agency_id = agency.agency.agency_id AND c.lifecycle_status = 'active'
			  )
			ON CONFLICT DO NOTHING
		`, [testAgencyIdA, testAgencyIdB]);

		// Step 4: Seed open sessions
		await pool.query(`
			INSERT INTO agency.agency_session
			  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
			SELECT agency_id, 'active', now(), now(), 'system:migration'
			FROM agency.agency
			WHERE agency_id IN ($1, $2)
			  AND NOT EXISTS (
			    SELECT 1 FROM agency.agency_session s
			    WHERE s.agency_id = agency.agency.agency_id AND s.ended_at IS NULL
			  )
		`, [testAgencyIdA, testAgencyIdB]);

		// AC-12: every agency has an open session
		const { rows: sessionGap } = await pool.query<{ count: string }>(`
			SELECT COUNT(*) AS count FROM agency.agency
			WHERE agency_id IN ($1, $2)
			  AND agency_id NOT IN (
			    SELECT agency_id FROM agency.agency_session WHERE ended_at IS NULL
			  )
		`, [testAgencyIdA, testAgencyIdB]);
		assert.equal(sessionGap[0].count, "0", "every agency must have an open session after migration");

		// AC-14: every agency has an active capacity row
		const { rows: capGap } = await pool.query<{ count: string }>(`
			SELECT COUNT(*) AS count FROM agency.agency
			WHERE agency_id IN ($1, $2)
			  AND agency_id NOT IN (
			    SELECT agency_id FROM agency.agency_capacity WHERE lifecycle_status = 'active'
			  )
		`, [testAgencyIdA, testAgencyIdB]);
		assert.equal(capGap[0].count, "0", "every agency must have an active capacity row after migration");
	});

	dbSkip("running migration Steps again (idempotency) does not raise or duplicate rows", async () => {
		// Re-run Step 1.5 and Step 2b for already-seeded agencies
		for (const id of [testAgencyIdA, testAgencyIdB]) {
			await pool.query(`
				INSERT INTO identity.principal (did, public_key, lifecycle_status, owner_did)
				VALUES ($1, $2, 'active', 'system:migration')
				ON CONFLICT (did) DO NOTHING
			`, [`did:agenthive:spawn:${id}`, Buffer.from(`placeholder-${id}`)]);
		}

		await pool.query(`
			INSERT INTO agency.agency_capacity (agency_id, max_concurrent, current_load, owner_did)
			SELECT agency_id, 1, 0, 'system:migration'
			FROM agency.agency
			WHERE agency_id IN ($1, $2)
			  AND NOT EXISTS (
			    SELECT 1 FROM agency.agency_capacity c
			    WHERE c.agency_id = agency.agency.agency_id AND c.lifecycle_status = 'active'
			  )
			ON CONFLICT DO NOTHING
		`, [testAgencyIdA, testAgencyIdB]);

		// Counts must still be 1 each (no duplication)
		for (const id of [testAgencyIdA, testAgencyIdB]) {
			const { rows } = await pool.query<{ count: string }>(`
				SELECT COUNT(*) AS count FROM agency.agency_capacity
				WHERE agency_id = $1 AND lifecycle_status = 'active'
			`, [id]);
			assert.equal(rows[0].count, "1", `agency ${id} must have exactly 1 active capacity row after idempotent re-run`);
		}
	});
});
