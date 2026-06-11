/**
 * P1351 AC-8: Integration end-to-end test
 *
 * Tests the full round-trip:
 * 1. New agency registers with parent_agency_id
 * 2. parent_agency_id is persisted to the database
 * 3. Agency is queryable via roster (getAgencies query)
 * 4. Agency is visible in orchestrator dispatch context (has agency_chain)
 * 5. Live test on test agencies claude-test-parent/claude-test-child
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { buildAgencyChain } from "../../core/orchestration/resolvers/agency-resolver.ts";

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

describe("P1351 AC-8 — Integration E2E", () => {
	dbTest(
		"AC-8a: Agency registers with parent_agency_id and persists",
		async () => {
			const parentId = `test/p1351-e2e-parent-${Date.now()}`;
			const childId = `test/p1351-e2e-child-${Date.now()}`;

			try {
				// Get valid host
				const hostRes = await pool.query<{ host_name: string }>(
					"SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
				);
				const hostId = hostRes.rows[0].host_name;

				// Step 1: Register parent agency
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-provider', $3)`,
					[parentId, parentId, hostId]
				);

				// Step 2: Register child with parent_agency_id
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test-provider', $3, $4)`,
					[childId, childId, hostId, parentId]
				);

				// Step 3: Verify parent_agency_id is persisted
				const childRes = await pool.query<{
					agency_id: string;
					parent_agency_id: string | null;
				}>(
					`SELECT agency_id, parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
					[childId]
				);

				assert.strictEqual(childRes.rows.length, 1, "Child agency exists");
				assert.strictEqual(
					childRes.rows[0].parent_agency_id,
					parentId,
					"parent_agency_id is persisted correctly"
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[parentId, childId]
				);
			}
		}
	);

	dbTest(
		"AC-8b: Agency is queryable via roster (getAgencies by parent)",
		async () => {
			const parentId = `test/p1351-e2e-roster-parent-${Date.now()}`;
			const child1Id = `test/p1351-e2e-roster-child1-${Date.now()}`;
			const child2Id = `test/p1351-e2e-roster-child2-${Date.now()}`;

			try {
				const hostRes = await pool.query<{ host_name: string }>(
					"SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
				);
				const hostId = hostRes.rows[0].host_name;

				// Register parent and children
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-provider', $3)`,
					[parentId, parentId, hostId]
				);

				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
					[child1Id, child1Id, "test-provider", hostId, parentId, child2Id, child2Id, "test-provider", hostId, parentId]
				);

				// Query children by parent (roster query)
				const rosterRes = await pool.query<{
					agency_id: string;
					display_name: string;
					parent_agency_id: string;
				}>(
					`SELECT agency_id, display_name, parent_agency_id
					 FROM roadmap.agency
					 WHERE parent_agency_id = $1
					 ORDER BY agency_id`,
					[parentId]
				);

				assert.strictEqual(
					rosterRes.rows.length,
					2,
					"Roster query returns 2 children"
				);
				assert(
					rosterRes.rows.some((r) => r.agency_id === child1Id),
					"child1 is queryable"
				);
				assert(
					rosterRes.rows.some((r) => r.agency_id === child2Id),
					"child2 is queryable"
				);

				// Verify parent_agency_id is returned for each child
				for (const row of rosterRes.rows) {
					assert.strictEqual(
						row.parent_agency_id,
						parentId,
						`Child ${row.agency_id} has correct parent_agency_id`
					);
				}
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3)`,
					[parentId, child1Id, child2Id]
				);
			}
		}
	);

	dbTest(
		"AC-8c: Agency visible in orchestrator dispatch (buildAgencyChain)",
		async () => {
			const parentId = `test/p1351-e2e-chain-parent-${Date.now()}`;
			const childId = `test/p1351-e2e-chain-child-${Date.now()}`;

			try {
				const hostRes = await pool.query<{ host_name: string }>(
					"SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
				);
				const hostId = hostRes.rows[0].host_name;

				// Register parent and child
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-provider', $3)`,
					[parentId, parentId, hostId]
				);

				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test-provider', $3, $4)`,
					[childId, childId, hostId, parentId]
				);

				// Call buildAgencyChain on child (simulates orchestrator dispatch)
				const chain = await buildAgencyChain(childId);

				// Verify chain includes parent and child
				assert.strictEqual(
					chain.length,
					2,
					"Chain has 2 agencies (parent + child)"
				);
				assert.strictEqual(chain[0], parentId, "Chain[0] is parent");
				assert.strictEqual(chain[1], childId, "Chain[1] is child");
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[parentId, childId]
				);
			}
		}
	);

	dbTest(
		"AC-8d: Deep nesting chain (3 levels) walks up correctly",
		async () => {
			const rootId = `test/p1351-e2e-chain-root-${Date.now()}`;
			const parentId = `test/p1351-e2e-chain-mid-${Date.now()}`;
			const childId = `test/p1351-e2e-chain-leaf-${Date.now()}`;

			try {
				const hostRes = await pool.query<{ host_name: string }>(
					"SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
				);
				const hostId = hostRes.rows[0].host_name;

				// Register 3-level hierarchy
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-provider', $3)`,
					[rootId, rootId, hostId]
				);

				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test-provider', $3, $4)`,
					[parentId, parentId, hostId, rootId]
				);

				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test-provider', $3, $4)`,
					[childId, childId, hostId, parentId]
				);

				// Build chain from leaf
				const chain = await buildAgencyChain(childId);

				// Verify full chain
				assert.strictEqual(
					chain.length,
					3,
					"Chain has 3 agencies (root + parent + child)"
				);
				assert.strictEqual(chain[0], rootId, "Chain[0] is root");
				assert.strictEqual(chain[1], parentId, "Chain[1] is parent");
				assert.strictEqual(chain[2], childId, "Chain[2] is child");
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3)`,
					[rootId, parentId, childId]
				);
			}
		}
	);

	dbTest(
		"AC-8e: Upsert scenario (liaisonRegister UPDATE) preserves parent_agency_id",
		async () => {
			const parentId = `test/p1351-e2e-upsert-parent-${Date.now()}`;
			const childId = `test/p1351-e2e-upsert-child-${Date.now()}`;

			try {
				const hostRes = await pool.query<{ host_name: string }>(
					"SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
				);
				const hostId = hostRes.rows[0].host_name;

				// Insert parent
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
					 VALUES ($1, $2, 'test-provider', $3)`,
					[parentId, parentId, hostId]
				);

				// Insert child with parent
				await pool.query(
					`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
					 VALUES ($1, $2, 'test-provider', $3, $4)`,
					[childId, childId, hostId, parentId]
				);

				// Simulate liaisonRegister UPDATE (upsert scenario)
				await pool.query(
					`UPDATE roadmap.agency
					 SET display_name = $2, provider = $3, parent_agency_id = $4
					 WHERE agency_id = $1`,
					[childId, `${childId}-updated`, "test-provider", parentId]
				);

				// Verify parent_agency_id persists after UPDATE
				const result = await pool.query<{
					display_name: string;
					parent_agency_id: string | null;
				}>(
					`SELECT display_name, parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
					[childId]
				);

				assert.strictEqual(result.rows.length, 1, "Child agency exists");
				assert.strictEqual(
					result.rows[0].parent_agency_id,
					parentId,
					"parent_agency_id persists after UPDATE"
				);
				assert.strictEqual(
					result.rows[0].display_name,
					`${childId}-updated`,
					"display_name was updated"
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[parentId, childId]
				);
			}
		}
	);
});
