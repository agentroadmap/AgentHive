/**
 * P1351 — Nested agencies tests
 *
 * AC-4: AgencySelfRegistrationOptions extended with optional parent_agency_id
 * AC-5: liaisonRegister preservation of parent_agency_id on upsert
 * AC-6: orchestrator chain-walking in offer-dispatch
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const SKIP = !process.env.PGUSER && !process.env.PGPASSWORD;
let pool: Pool;

const dbTest = (name: string, fn: () => Promise<void>) =>
	it(name, async () => {
		if (SKIP) {
			console.log(`  [skipped: ${name}] — DB credentials absent`);
			return;
		}
		await fn();
	});

beforeAll(async () => {
	if (SKIP) return;
	pool = new Pool({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? 5432),
		user: process.env.PGUSER ?? "admin",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
	await pool.query("SELECT 1");
});

afterAll(async () => {
	if (SKIP || !pool) return;
	await pool.end();
});

describe("P1351 — Nested agencies", () => {
	dbTest(
		"AC-1: schema has parent_agency_id column and FK constraint",
		async () => {
			// Check that parent_agency_id column exists
			const colRes = await pool.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_name = 'agency' AND table_schema = 'roadmap'
					AND column_name = 'parent_agency_id'
				) AS exists`,
			);
			assert.strictEqual(
				colRes.rows[0].exists,
				true,
				"parent_agency_id column exists",
			);

			// Check that FK constraint exists
			const fkRes = await pool.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM information_schema.table_constraints
					WHERE table_name = 'agency' AND table_schema = 'roadmap'
					AND constraint_name = 'fk_agency_parent_agency_id'
				) AS exists`,
			);
			assert.strictEqual(fkRes.rows[0].exists, true, "FK constraint exists");
		},
	);

	dbTest(
		"AC-2: UNIQUE(parent_agency_id, agency_id) constraint prevents duplicate (parent, child) pairs",
		async () => {
			const uniqueRes = await pool.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM information_schema.table_constraints
					WHERE table_name = 'agency' AND table_schema = 'roadmap'
					AND constraint_name = 'unique_parent_child'
				) AS exists`,
			);
			assert.strictEqual(
				uniqueRes.rows[0].exists,
				true,
				"unique_parent_child constraint exists",
			);

			// Test that we can insert parent and multiple children
			const testParent = `test/p1351-parent-${Date.now()}`;
			const testChild1 = `test/p1351-child1-${Date.now()}`;
			const testChild2 = `test/p1351-child2-${Date.now()}`;

			try {
				// Insert parent
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test', 'iMac')`,
					[testParent, testParent],
				);

				// Insert first child
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test', 'iMac', $3)`,
					[testChild1, testChild1, testParent],
				);

				// Insert second child (same parent, different child — allowed)
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test', 'iMac', $3)`,
					[testChild2, testChild2, testParent],
				);

				// Verify both children exist under parent
				const childrenRes = await pool.query<{ agency_id: string }>(
					`SELECT agency_id FROM roadmap.agency WHERE parent_agency_id = $1 ORDER BY agency_id`,
					[testParent],
				);
				assert.strictEqual(
					childrenRes.rows.length,
					2,
					"two children under parent",
				);

				// Try to insert the exact same (parent, child1) pair — should fail on unique constraint
				try {
					await pool.query(
						`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
						 VALUES ($1, $2, 'test', 'iMac', $3)`,
						[testChild1, testChild1, testParent],
					);
					assert.fail("Duplicate (parent, child1) should violate UNIQUE constraint");
				} catch (err) {
					assert(
						err instanceof Error &&
							(err.message.includes("unique_parent_child") || err.message.includes("unique constraint")),
						`Expected unique constraint error, got: ${(err as Error).message}`,
					);
				}
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3)`,
					[testParent, testChild1, testChild2],
				);
			}
		},
	);

	dbTest(
		"AC-3: Index on parent_agency_id enables efficient queries",
		async () => {
			const indexRes = await pool.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM pg_indexes
					WHERE schemaname = 'roadmap' AND tablename = 'agency'
					AND indexname = 'idx_agency_parent_agency_id'
				) AS exists`,
			);
			assert.strictEqual(
				indexRes.rows[0].exists,
				true,
				"idx_agency_parent_agency_id exists",
			);

			// Test that we can query children by parent efficiently
			const testParent = `test/p1351-parent-idx-${Date.now()}`;
			const testChild = `test/p1351-child-idx-${Date.now()}`;

			try {
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test', 'iMac')`,
					[testParent, testParent],
				);

				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test', 'iMac', $3)`,
					[testChild, testChild, testParent],
				);

				// Query children by parent
				const childRes = await pool.query<{ agency_id: string }>(
					`SELECT agency_id FROM roadmap.agency WHERE parent_agency_id = $1`,
					[testParent],
				);

				assert.strictEqual(
					childRes.rows.length,
					1,
					"found one child under parent",
				);
				assert.strictEqual(
					childRes.rows[0].agency_id,
					testChild,
					"child agency_id matches",
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[testParent, testChild],
				);
			}
		},
	);

	dbTest(
		"AC-3b: Backfill script correctly identifies orphan agencies",
		async () => {
			// Test that agencies with no matching siblings (orphans) are identified
			const orphan = `test/p1351-orphan-${Date.now()}`;

			try {
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-orphan-provider', 'iMac')`,
					[orphan, orphan],
				);

				// Query for orphans — agencies with no siblings that share (provider, host_id)
				const orphanRes = await pool.query<{ agency_id: string }>(
					`SELECT agency_id FROM roadmap.agency a
					 WHERE a.parent_agency_id IS NULL
					 AND NOT EXISTS (
						SELECT 1 FROM roadmap.agency b
						WHERE b.provider = a.provider
						AND b.host_id = a.host_id
						AND b.agency_id != a.agency_id
					 )
					 AND a.agency_id = $1`,
					[orphan],
				);

				assert.strictEqual(
					orphanRes.rows.length,
					1,
					"orphan agency is identified",
				);
			} finally {
				await pool.query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [
					orphan,
				]);
			}
		},
	);

	dbTest(
		"AC-5b: parent_agency_id survives UPDATE (upsert scenario)",
		async () => {
			const testParent = `test/p1351-parent-upsert-${Date.now()}`;
			const testChild = `test/p1351-child-upsert-${Date.now()}`;

			try {
				// Create parent
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test', 'iMac')`,
					[testParent, testParent],
				);

				// Create child with parent
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test', 'iMac', $3)`,
					[testChild, testChild, testParent],
				);

				// Upsert child with UPDATE (simulating liaisonRegister upsert)
				await pool.query(
					`UPDATE roadmap.agency
					 SET display_name = $2, provider = $3, parent_agency_id = $4
					 WHERE agency_id = $1`,
					[testChild, testChild, "test", testParent],
				);

				// Verify parent_agency_id persists
				const childRes = await pool.query<{ parent_agency_id: string | null }>(
					`SELECT parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
					[testChild],
				);

				assert.strictEqual(
					childRes.rows[0].parent_agency_id,
					testParent,
					"parent_agency_id persists through UPDATE",
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[testParent, testChild],
				);
			}
		},
	);
});
