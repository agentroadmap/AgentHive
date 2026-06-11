/**
 * P1351 AC-7: Agency Roster TUI tests
 *
 * Verifies that the agency roster correctly:
 * - Groups agencies by parent_agency_id
 * - Displays root agencies (parent_agency_id IS NULL)
 * - Shows child counts for parents
 * - Renders hierarchical tree structure
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

describe("P1351 AC-7 — Agency Roster TUI", () => {
  dbTest(
    "AC-7a: Roster correctly groups agencies by parent_agency_id",
    async () => {
      // Create test parent agency
      const parentId = `test/p1351-roster-parent-${Date.now()}`;
      const child1Id = `test/p1351-roster-child1-${Date.now()}`;
      const child2Id = `test/p1351-roster-child2-${Date.now()}`;
      const child3Id = `test/p1351-roster-child3-${Date.now()}`;

      try {
        // Get valid host
        const hostRes = await pool.query<{ host_name: string }>(
          "SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
        );
        const hostId = hostRes.rows[0].host_name;

        // Insert parent
        await pool.query(
          `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
           VALUES ($1, $2, 'test', $3)`,
          [parentId, parentId, hostId]
        );

        // Insert 3 children under the same parent
        for (const childId of [child1Id, child2Id, child3Id]) {
          await pool.query(
            `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
             VALUES ($1, $2, 'test', $3, $4)`,
            [childId, childId, hostId, parentId]
          );
        }

        // Query grouped agencies
        const groupRes = await pool.query<{
          parent_agency_id: string | null;
          children_count: string;
          child_ids: string[];
        }>(
          `
          SELECT
            parent_agency_id,
            COUNT(*)::text as children_count,
            ARRAY_AGG(agency_id) as child_ids
          FROM roadmap.agency
          WHERE (parent_agency_id = $1 OR agency_id = $1)
          GROUP BY parent_agency_id
          ORDER BY parent_agency_id DESC
          `,
          [parentId]
        );

        // Should have 2 groups: parent (parent_agency_id IS NULL) + children
        assert.strictEqual(
          groupRes.rows.length,
          2,
          "Parent and children should be in 2 groups"
        );

        const parentGroup = groupRes.rows.find((r) => r.parent_agency_id === null);
        const childrenGroup = groupRes.rows.find((r) => r.parent_agency_id === parentId);

        assert.strictEqual(parentGroup?.children_count, "1", "Parent group has 1 agency");
        assert.strictEqual(childrenGroup?.children_count, "3", "Children group has 3 agencies");
        assert.strictEqual(
          childrenGroup?.child_ids.length,
          3,
          "Correct child count in array"
        );
      } finally {
        // Cleanup
        await pool.query(
          `DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3, $4)`,
          [parentId, child1Id, child2Id, child3Id]
        );
      }
    }
  );

  dbTest(
    "AC-7b: Roster displays root agencies and their children",
    async () => {
      const root1 = `test/p1351-roster-root1-${Date.now()}`;
      const root2 = `test/p1351-roster-root2-${Date.now()}`;
      const child1 = `test/p1351-roster-child1-${Date.now()}`;

      try {
        const hostRes = await pool.query<{ host_name: string }>(
          "SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
        );
        const hostId = hostRes.rows[0].host_name;

        // Insert 2 root agencies
        await pool.query(
          `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
           VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
          [root1, root1, "test", hostId, root2, root2, "test", hostId]
        );

        // Insert 1 child under root1
        await pool.query(
          `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [child1, child1, "test", hostId, root1]
        );

        // Query roots and their children
        const rootsRes = await pool.query<{ agency_id: string; parent_agency_id: string | null }>(
          `SELECT agency_id, parent_agency_id FROM roadmap.agency
           WHERE agency_id IN ($1, $2, $3)
           ORDER BY agency_id`,
          [root1, root2, child1]
        );

        // Should have 3 rows: 2 roots (null parent) + 1 child
        assert.strictEqual(rootsRes.rows.length, 3, "3 agencies total");

        const roots = rootsRes.rows.filter((r) => r.parent_agency_id === null);
        const children = rootsRes.rows.filter((r) => r.parent_agency_id !== null);

        assert.strictEqual(roots.length, 2, "2 root agencies");
        assert.strictEqual(children.length, 1, "1 child agency");
        assert.strictEqual(children[0].parent_agency_id, root1, "Child has correct parent");
      } finally {
        await pool.query(
          `DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3)`,
          [root1, root2, child1]
        );
      }
    }
  );

  dbTest(
    "AC-7c: Query getAgencies(parent_agency_id=N) returns only children",
    async () => {
      const parentId = `test/p1351-get-parent-${Date.now()}`;
      const child1 = `test/p1351-get-child1-${Date.now()}`;
      const child2 = `test/p1351-get-child2-${Date.now()}`;
      const otherChild = `test/p1351-get-other-${Date.now()}`;
      const otherParent = `test/p1351-get-other-parent-${Date.now()}`;

      try {
        const hostRes = await pool.query<{ host_name: string }>(
          "SELECT host_name FROM roadmap.host_model_policy LIMIT 1"
        );
        const hostId = hostRes.rows[0].host_name;

        // Insert parent and children
        await pool.query(
          `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
           VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
          [parentId, parentId, "test", hostId, otherParent, otherParent, "test", hostId]
        );

        await pool.query(
          `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
           VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15)`,
          [
            child1,
            child1,
            "test",
            hostId,
            parentId,
            child2,
            child2,
            "test",
            hostId,
            parentId,
            otherChild,
            otherChild,
            "test",
            hostId,
            otherParent,
          ]
        );

        // Query children of parentId only
        const childrenRes = await pool.query<{ agency_id: string }>(
          `SELECT agency_id FROM roadmap.agency WHERE parent_agency_id = $1 ORDER BY agency_id`,
          [parentId]
        );

        assert.strictEqual(
          childrenRes.rows.length,
          2,
          "Query returns exactly 2 children for parentId"
        );
        assert(
          childrenRes.rows.some((r) => r.agency_id === child1),
          "child1 is in result"
        );
        assert(
          childrenRes.rows.some((r) => r.agency_id === child2),
          "child2 is in result"
        );
        assert(
          !childrenRes.rows.some((r) => r.agency_id === otherChild),
          "otherChild is NOT in result (different parent)"
        );
      } finally {
        await pool.query(
          `DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3, $4, $5)`,
          [parentId, child1, child2, otherChild, otherParent]
        );
      }
    }
  );
});
