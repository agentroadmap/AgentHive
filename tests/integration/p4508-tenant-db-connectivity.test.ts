/**
 * P4508 AC-1/AC-2 integration tests — getProjectDb() connects to live tenant DBs.
 *
 * AC-1: getProjectDb('georgia-singer') and getProjectDb('monkeyKing-audio') return
 *   a connected pool after migration 303 seeds dsn_secret_ref with a direct postgres:// DSN.
 *
 * AC-2: createTenantPoolOnce falls back to tenant_db_url directly when dsn_secret_ref
 *   is NULL — verified by inserting a test project row with NULL dsn_secret_ref.
 *
 * Skipped unless AGENTHIVE_ALLOW_LIVE_DB=1 (hits live DB).
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "pg";
import {
	getProjectDb,
	resetForTesting,
	TenantSecretUnavailable,
} from "../../src/postgres/pool-registry.ts";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

afterEach(async () => {
	await resetForTesting();
});

describe(
	"P4508 AC-1: tenant DB connectivity for live projects (dsn_secret_ref = postgres:// DSN)",
	{ skip: !LIVE },
	() => {
		it("getProjectDb('georgia-singer') returns a connected pool", async () => {
			let pool;
			try {
				pool = await getProjectDb("georgia-singer");
			} catch (err) {
				if (err instanceof TenantSecretUnavailable) {
					assert.fail(
						`TenantSecretUnavailable — migration 303 may not be applied or tenant_db_url/dsn_secret_ref not set: ${err.message}`,
					);
				}
				throw err;
			}
			const result = await pool.query<{ one: string }>("SELECT 1::text AS one");
			assert.equal(result.rows[0]?.one, "1");
		});

		it("getProjectDb('monkeyKing-audio') returns a connected pool", async () => {
			let pool;
			try {
				pool = await getProjectDb("monkeyKing-audio");
			} catch (err) {
				if (err instanceof TenantSecretUnavailable) {
					assert.fail(
						`TenantSecretUnavailable — migration 303 may not be applied or tenant_db_url/dsn_secret_ref not set: ${err.message}`,
					);
				}
				throw err;
			}
			const result = await pool.query<{ one: string }>("SELECT 1::text AS one");
			assert.equal(result.rows[0]?.one, "1");
		});
	},
);

describe(
	"P4508 AC-2: NULL dsn_secret_ref + valid tenant_db_url → pool created directly",
	{ skip: !LIVE },
	() => {
		let testSlug: string;
		let adminClient: Client;

		it("createTenantPoolOnce uses tenant_db_url when dsn_secret_ref is NULL", async () => {
			// Connect directly as admin to insert a test project row
			adminClient = new Client({
				host: process.env.PGHOST ?? "127.0.0.1",
				port: Number(process.env.PGPORT ?? 5432),
				user: process.env.PGUSER ?? "admin",
				database: process.env.PGDATABASE ?? "agenthive",
				password: process.env.PGPASSWORD,
			});
			await adminClient.connect();

			testSlug = `p4508-ac2-test-${Date.now()}`;
			// tenant_db_url points at the control DB itself (always accessible)
			const tenantDbUrl = `postgresql://${process.env.PGUSER ?? "admin"}:${process.env.PGPASSWORD}@${process.env.PGHOST ?? "127.0.0.1"}:${process.env.PGPORT ?? 5432}/${process.env.PGDATABASE ?? "agenthive"}`;

			await adminClient.query(
				`INSERT INTO roadmap.project
					(slug, name, worktree_root, status, bootstrap_status, dsn_secret_ref, tenant_db_url)
				 VALUES ($1, $1, '/tmp', 'active', 'pending', NULL, $2)`,
				[testSlug, tenantDbUrl],
			);

			try {
				const pool = await getProjectDb(testSlug);
				const result = await pool.query<{ one: string }>("SELECT 1::text AS one");
				assert.equal(result.rows[0]?.one, "1", "pool connected via tenant_db_url direct path");
			} finally {
				// Cleanup: remove test row
				await adminClient.query(
					`DELETE FROM roadmap.project WHERE slug = $1`,
					[testSlug],
				);
				await adminClient.end().catch(() => {});
			}
		});
	},
);
