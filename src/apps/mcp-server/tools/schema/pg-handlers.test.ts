/**
 * P1109 Tier-1 & Tier-4: schema introspection + migration linting.
 *
 * AC-1/AC-8: describeTable returns columns/constraints/triggers/indexes.
 * AC-12: lintMigration runs SQL in a real BEGIN/ROLLBACK on ONE held client.
 * AC-13: lintMigration catches fabrication (invalid CHECK, fabricated column).
 *
 * Env-gated (AGENTHIVE_RESOLVER_DB_TEST=1) so it never runs against the live DB
 * in the default suite. The lint itself always ROLLBACKs, so even the live run
 * never persists.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { query } from "../../../../infra/postgres/pool.ts";
import { describeTable, lintMigration } from "./pg-handlers.ts";

const DB = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

describe("describeTable (P1109 AC-1/AC-8)", { skip: !DB }, () => {
	test("qualified table roadmap.agency → found with columns", async () => {
		const r = await describeTable("roadmap.agency");
		assert.equal(r.found, true);
		assert.equal(r.schema, "roadmap");
		assert.equal(r.table, "agency");
		assert.ok(r.columns.length > 0);
		assert.ok(r.columns[0].column_name);
		assert.ok(r.columns[0].data_type);
	});

	test("bare name 'agency' resolves via search path", async () => {
		const r = await describeTable("agency");
		assert.equal(r.found, true);
		assert.equal(r.schema, "roadmap");
		assert.equal(r.table, "agency");
	});

	test("non-existent table → found=false + error", async () => {
		const r = await describeTable("nonexistent_table_xyz");
		assert.equal(r.found, false);
		assert.ok(r.error);
		assert.equal(r.columns.length, 0);
	});

	test("indexes are returned for roadmap.agency", async () => {
		const r = await describeTable("roadmap.agency");
		assert.equal(r.found, true);
		assert.ok(r.indexes.length > 0);
		assert.ok(r.indexes[0].name);
		assert.equal(typeof r.indexes[0].is_unique, "boolean");
	});
});

describe("lintMigration (P1109 AC-12/AC-13)", { skip: !DB }, () => {
	test("valid SQL → valid:true", async () => {
		const r = await lintMigration(
			"CREATE TEMPORARY TABLE t_lint_ok (id uuid primary key, name text not null);",
		);
		assert.equal(r.valid, true);
		assert.deepEqual(r.errors, []);
	});

	test("CRITICAL: a valid CREATE TABLE is ROLLED BACK, never persisted", async () => {
		// This is the regression guard for the autocommit bug: if BEGIN/script/
		// ROLLBACK ran on different pooled connections, this real (non-TEMP) table
		// would survive the lint. lintMigration must hold one client and roll back.
		const probe = "roadmap.p1109_lint_rollback_probe";
		// Pre-clean in case a prior buggy run leaked it.
		await query(`DROP TABLE IF EXISTS ${probe}`);
		const r = await lintMigration(
			`CREATE TABLE ${probe} (id bigint primary key);`,
		);
		assert.equal(r.valid, true, "valid DDL should lint clean");
		// The table MUST NOT exist afterwards — proof the ROLLBACK reverted it.
		const exists = await query<{ reg: string | null }>(
			`SELECT to_regclass($1) AS reg`,
			[probe],
		);
		assert.equal(
			exists.rows[0].reg,
			null,
			"lint must NOT persist the CREATE TABLE — autocommit/cross-connection bug",
		);
	});

	test("AC-13: invalid CHECK value → valid:false naming the violation", async () => {
		const r = await lintMigration(`
			CREATE TABLE t_check (id uuid primary key, status text CHECK (status IN ('active','inactive')));
			INSERT INTO t_check (id, status) VALUES (gen_random_uuid(), 'invalid_status');
		`);
		assert.equal(r.valid, false);
		assert.ok(r.errors.length > 0);
		assert.match(r.errors[0].toLowerCase(), /check|violates/);
	});

	test("AC-13: fabricated column → valid:false", async () => {
		const r = await lintMigration(
			"UPDATE roadmap.agency SET nonexistent_column = 'x' WHERE agency_id = 'none';",
		);
		assert.equal(r.valid, false);
		assert.ok(r.errors.length > 0);
		assert.match(r.errors[0], /column|does not exist/i);
	});

	test("dollar-quoted BEGIN/END preserved (not stripped as txn control)", async () => {
		const r = await lintMigration(`
			CREATE OR REPLACE FUNCTION t_fn() RETURNS void AS $$
			BEGIN
			  RAISE NOTICE 'x';
			END;
			$$ LANGUAGE plpgsql;
		`);
		assert.equal(r.valid, true);
		assert.deepEqual(r.errors, []);
	});

	test("top-level BEGIN/COMMIT stripped, script still lints clean", async () => {
		const r = await lintMigration(`
			BEGIN;
			CREATE TEMPORARY TABLE t_strip (id uuid primary key);
			COMMIT;
		`);
		assert.equal(r.valid, true);
		assert.deepEqual(r.errors, []);
	});

	test("top-level JSDoc /** block → valid:false", async () => {
		const r = await lintMigration(
			"/** migration */\nCREATE TEMPORARY TABLE t_js (id uuid primary key);",
		);
		assert.equal(r.valid, false);
		assert.match(r.errors[0], /JSDoc/);
	});
});
