/**
 * P926 AC-8: Umbrella closeout checker function
 *
 * This test verifies the fn_check_umbrella_closeout() function.
 * The function returns TRUE if all children of an umbrella proposal
 * are in terminal state (COMPLETE or maturity='obsolete'), FALSE otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { query as defaultQuery } from "../src/infra/postgres/pool.ts";

// LIVE-DB TEST: inserts fixture proposals (with teardown). Skipped by default
// to keep the suite hermetic; run with AGENTHIVE_ALLOW_LIVE_DB=1.
const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

describe.skipIf(!LIVE)("P926 AC-8: fn_check_umbrella_closeout()", () => {
  const query = defaultQuery;
  let testUmbrellaId: number;
  const testChildIds: number[] = [];

  beforeAll(async () => {
    // Create test umbrella proposal
    const umbrellaResult = await query(
      `
      INSERT INTO roadmap_proposal.proposal
        (display_id, type, status, title, maturity, project_id, audit)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      ["P-TEST-926-UMBRELLA", "feature", "DEVELOP", "Test Umbrella P926", "new", 1, "{}"]
    );
    testUmbrellaId = umbrellaResult.rows[0].id;

    // Create 3 test children: 2 COMPLETE, 1 DEVELOP
    const child1 = await query(
      `
      INSERT INTO roadmap_proposal.proposal
        (display_id, type, status, title, maturity, parent_id, project_id, audit)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      ["P-TEST-926-C1", "feature", "COMPLETE", "Test Child 1", "new", testUmbrellaId, 1, "{}"]
    );
    testChildIds.push(child1.rows[0].id);

    const child2 = await query(
      `
      INSERT INTO roadmap_proposal.proposal
        (display_id, type, status, title, maturity, parent_id, project_id, audit)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      ["P-TEST-926-C2", "feature", "COMPLETE", "Test Child 2", "new", testUmbrellaId, 1, "{}"]
    );
    testChildIds.push(child2.rows[0].id);

    const child3 = await query(
      `
      INSERT INTO roadmap_proposal.proposal
        (display_id, type, status, title, maturity, parent_id, project_id, audit)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      ["P-TEST-926-C3", "feature", "DEVELOP", "Test Child 3", "new", testUmbrellaId, 1, "{}"]
    );
    testChildIds.push(child3.rows[0].id);
  });

  afterAll(async () => {
    // Clean up: delete proposals in reverse order
    for (const childId of testChildIds) {
      await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [childId]);
    }
    await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [testUmbrellaId]);
  });

  it("should return FALSE when not all children are terminal", async () => {
    const result = await query(
      `SELECT roadmap_proposal.fn_check_umbrella_closeout($1) AS result`,
      [testUmbrellaId]
    );
    // FALSE expected: one child still DEVELOP
    expect(result.rows[0].result).toBe(false);
  });

  it("should return TRUE when all children are COMPLETE", async () => {
    // Update the remaining DEVELOP child to COMPLETE
    await query(
      `UPDATE roadmap_proposal.proposal SET status = 'COMPLETE' WHERE id = $1`,
      [testChildIds[2]]
    );

    const result = await query(
      `SELECT roadmap_proposal.fn_check_umbrella_closeout($1) AS result`,
      [testUmbrellaId]
    );
    expect(result.rows[0].result).toBe(true);
  });

  it("should return TRUE for umbrella with no children", async () => {
    // Create an umbrella with no children
    const emptyUmbrella = await query(
      `
      INSERT INTO roadmap_proposal.proposal
        (display_id, type, status, title, maturity, project_id, audit)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      ["P-TEST-926-EMPTY", "feature", "DEVELOP", "Empty Umbrella", "new", 1, "{}"]
    );

    const result = await query(
      `SELECT roadmap_proposal.fn_check_umbrella_closeout($1) AS result`,
      [emptyUmbrella.rows[0].id]
    );
    // trivially satisfied: no children
    expect(result.rows[0].result).toBe(true);

    // Clean up
    await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [
      emptyUmbrella.rows[0].id,
    ]);
  });
});
