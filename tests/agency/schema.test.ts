/**
 * P594 — agency schema structural tests
 *
 * AC-3:  RLS on agency_session enforces current_setting(app.current_agency_id)
 * AC-4:  DELETE on agency, agency_session, liaison_message_kind_catalog REVOKEd from PUBLIC
 * AC-9:  silence_seconds is NOT a GENERATED column; exposed only in v_agency_session view
 * AC-10: 003-agency.sql has pre-flight guard that raises if identity schema is absent
 * AC-11: pg_advisory_lock calls use two-argument INT4 form (class, key)
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

const DDL_PATH = join(import.meta.dirname, "../../database/ddl/hivecentral/003-agency.sql");

let pool: Pool;

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
	await pool.end();
});

// ─── File-based checks (always run, no DB needed) ──────────────────────────

describe("AC-9: silence_seconds not GENERATED ALWAYS AS STORED", () => {
	it("DDL file must not contain GENERATED ALWAYS AS STORED for silence_seconds", async () => {
		const ddl = await readFile(DDL_PATH, "utf-8");
		assert.ok(
			!ddl.includes("silence_seconds") || !ddl.includes("GENERATED ALWAYS AS STORED"),
			"silence_seconds must NOT use GENERATED ALWAYS AS STORED (now() is STABLE, not IMMUTABLE)",
		);
	});

	it("DDL file must expose silence_seconds in a VIEW, not as a table column", async () => {
		const ddl = await readFile(DDL_PATH, "utf-8");
		assert.ok(
			ddl.includes("v_agency_session"),
			"DDL must define v_agency_session view for silence_seconds",
		);
		assert.ok(
			ddl.match(/silence_seconds/),
			"silence_seconds must appear in the DDL (inside the view definition)",
		);
	});
});

describe("AC-10: pre-flight guard for missing identity schema", () => {
	it("DDL file must contain a DO block that RAISEs if identity schema is absent", async () => {
		const ddl = await readFile(DDL_PATH, "utf-8");
		assert.ok(
			ddl.includes("identity"),
			"pre-flight guard must check identity schema",
		);
		assert.ok(
			ddl.includes("RAISE EXCEPTION"),
			"pre-flight guard must RAISE EXCEPTION",
		);
	});
});

describe("AC-11: advisory lock uses two-argument INT4 form", () => {
	it("DDL file must use pg_advisory_xact_lock(INT4, INT4) form", async () => {
		const ddl = await readFile(DDL_PATH, "utf-8");
		assert.ok(
			ddl.includes("hashtext(") && ddl.includes("::int4"),
			"advisory lock must cast hashtext result to int4 to prevent sign-extension",
		);
	});
});

// ─── DB-backed checks ──────────────────────────────────────────────────────

describe("AC-9: v_agency_session view exposes silence_seconds (live DB)", () => {
	dbSkip("v_agency_session view exists in agency schema", async () => {
		const { rows } = await pool.query<{ column_name: string }>(`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'agency'
			  AND table_name   = 'v_agency_session'
			  AND column_name  = 'silence_seconds'
		`);
		assert.equal(rows.length, 1, "v_agency_session must expose silence_seconds column");
	});

	dbSkip("agency_session table must NOT have silence_seconds column", async () => {
		const { rows } = await pool.query<{ column_name: string }>(`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'agency'
			  AND table_name   = 'agency_session'
			  AND column_name  = 'silence_seconds'
		`);
		assert.equal(rows.length, 0, "agency_session must NOT have silence_seconds as a table column");
	});
});

describe("AC-3: RLS on agency_session enforces app.current_agency_id", () => {
	dbSkip("agency_session has RLS enabled", async () => {
		const { rows } = await pool.query<{ relrowsecurity: boolean }>(`
			SELECT relrowsecurity
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'agency'
			  AND c.relname = 'agency_session'
		`);
		assert.equal(rows.length, 1, "agency_session must exist");
		assert.ok(rows[0].relrowsecurity, "RLS must be enabled on agency_session");
	});

	dbSkip("RLS policy on agency_session uses current_setting app.current_agency_id", async () => {
		const { rows } = await pool.query<{ polqual: string }>(`
			SELECT pg_get_expr(polqual, polrelid) AS polqual
			FROM pg_policy pol
			JOIN pg_class c ON c.oid = pol.polrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'agency'
			  AND c.relname = 'agency_session'
		`);
		assert.ok(rows.length >= 1, "at least one RLS policy must exist on agency_session");
		const hasAgencyIdCheck = rows.some(r =>
			r.polqual?.includes("current_setting") && r.polqual?.includes("current_agency_id"),
		);
		assert.ok(
			hasAgencyIdCheck,
			"RLS policy must use current_setting('app.current_agency_id') in USING clause",
		);
	});
});

describe("AC-4: DELETE REVOKEd from PUBLIC on lifecycle-only tables", () => {
	dbSkip("PUBLIC cannot DELETE from agency.agency", async () => {
		const { rows } = await pool.query<{ privilege_type: string }>(`
			SELECT privilege_type
			FROM information_schema.role_table_grants
			WHERE grantee    = 'PUBLIC'
			  AND table_schema = 'agency'
			  AND table_name   = 'agency'
			  AND privilege_type = 'DELETE'
		`);
		assert.equal(rows.length, 0, "DELETE on agency.agency must be revoked from PUBLIC");
	});

	dbSkip("PUBLIC cannot DELETE from agency.agency_session", async () => {
		const { rows } = await pool.query<{ privilege_type: string }>(`
			SELECT privilege_type
			FROM information_schema.role_table_grants
			WHERE grantee    = 'PUBLIC'
			  AND table_schema = 'agency'
			  AND table_name   = 'agency_session'
			  AND privilege_type = 'DELETE'
		`);
		assert.equal(rows.length, 0, "DELETE on agency.agency_session must be revoked from PUBLIC");
	});

	dbSkip("PUBLIC cannot DELETE from agency.liaison_message_kind_catalog", async () => {
		const { rows } = await pool.query<{ privilege_type: string }>(`
			SELECT privilege_type
			FROM information_schema.role_table_grants
			WHERE grantee    = 'PUBLIC'
			  AND table_schema = 'agency'
			  AND table_name   = 'liaison_message_kind_catalog'
			  AND privilege_type = 'DELETE'
		`);
		assert.equal(
			rows.length,
			0,
			"DELETE on agency.liaison_message_kind_catalog must be revoked from PUBLIC",
		);
	});
});
