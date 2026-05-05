/**
 * P438 Integration Tests — Claim Policy Fail Closed
 *
 * AC coverage:
 *   AC-1: squad_dispatch CHECK: required_capabilities is non-empty JSONB array
 *   AC-2: squad_dispatch CHECK: project_id IS NOT NULL
 *   AC-3: squad_dispatch CHECK: dispatch_role IS NOT NULL
 *   AC-4: claim_rejection audit rows written for each gate failure
 *   AC-5: empty required_capabilities → CHECK constraint violation
 *   AC-6: NULL project_id → CHECK constraint violation
 *
 * Prerequisites: migration 067 applied, PGPASSWORD set.
 * Skip gracefully when DB is unavailable.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool } from "pg";

const SKIP = !process.env.PGPASSWORD;
const skip = (name: string, fn: () => Promise<void>) =>
  SKIP ? it.skip(name, fn) : it(name, fn);

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
});

after(async () => {
  if (!pool) return;
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findAnyProject(client: Pool): Promise<number | null> {
  const { rows } = await client.query<{ project_id: number }>(
    `SELECT project_id FROM roadmap.project LIMIT 1`
  );
  return rows[0]?.project_id ?? null;
}

// ─── AC-1 + AC-5: required_capabilities CHECK ─────────────────────────────────

describe("AC-1 + AC-5: squad_dispatch required_capabilities must be non-empty array", () => {
  skip("CHECK constraint sd_required_capabilities_nonempty exists", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'roadmap_workforce.squad_dispatch'::regclass
        AND conname   = 'sd_required_capabilities_nonempty'
    `);
    assert.equal(rows.length, 1, "sd_required_capabilities_nonempty constraint not found");
  });

  skip("INSERT with empty array [] raises CHECK violation", async () => {
    const projectId = await findAnyProject(pool);
    if (!projectId) return;

    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, squad_name, dispatch_role, dispatch_status,
           offer_status, required_capabilities, project_id)
        VALUES (1, 'test-squad', 'tester', 'open', 'open', '[]'::jsonb, $1)
      `, [projectId]),
      /check.*violation|constraint/i,
      "Expected CHECK violation on empty required_capabilities array"
    );
  });

  skip("INSERT with non-array {} raises CHECK violation", async () => {
    const projectId = await findAnyProject(pool);
    if (!projectId) return;

    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, squad_name, dispatch_role, dispatch_status,
           offer_status, required_capabilities, project_id)
        VALUES (1, 'test-squad', 'tester', 'open', 'open', '{}'::jsonb, $1)
      `, [projectId]),
      /check.*violation|constraint/i,
      "Expected CHECK violation on object-format required_capabilities"
    );
  });

  skip("INSERT with valid array [\"general\"] succeeds", async () => {
    const projectId = await findAnyProject(pool);
    if (!projectId) return;

    const { rows } = await pool.query<{ id: number }>(`
      INSERT INTO roadmap_workforce.squad_dispatch
        (proposal_id, squad_name, dispatch_role, dispatch_status,
         offer_status, required_capabilities, project_id)
      VALUES (1, 'test-squad', 'tester', 'open', 'delivered', '["general"]'::jsonb, $1)
      RETURNING id
    `, [projectId]);

    assert.ok(rows[0]?.id, "INSERT should succeed with valid capabilities array");

    // Cleanup
    await pool.query(
      "DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1",
      [rows[0].id]
    );
  });
});

// ─── AC-2 + AC-6: project_id CHECK ────────────────────────────────────────────

describe("AC-2 + AC-6: squad_dispatch project_id must be NOT NULL", () => {
  skip("CHECK constraint sd_project_id_notnull exists", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'roadmap_workforce.squad_dispatch'::regclass
        AND conname   = 'sd_project_id_notnull'
    `);
    assert.equal(rows.length, 1, "sd_project_id_notnull constraint not found");
  });

  skip("INSERT with NULL project_id raises CHECK violation", async () => {
    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, squad_name, dispatch_role, dispatch_status,
           offer_status, required_capabilities, project_id)
        VALUES (1, 'test-squad', 'tester', 'open', 'open', '["general"]'::jsonb, NULL)
      `),
      /check.*violation|constraint|not.*null/i,
      "Expected CHECK violation on NULL project_id"
    );
  });
});

// ─── AC-3: dispatch_role CHECK ────────────────────────────────────────────────

describe("AC-3: squad_dispatch dispatch_role must be NOT NULL", () => {
  skip("CHECK constraint sd_dispatch_role_notnull exists", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'roadmap_workforce.squad_dispatch'::regclass
        AND conname   = 'sd_dispatch_role_notnull'
    `);
    assert.equal(rows.length, 1, "sd_dispatch_role_notnull constraint not found");
  });
});

// ─── AC-4: claim_rejection audit table ────────────────────────────────────────

describe("AC-4: control_audit.claim_rejection table exists and accepts rows", () => {
  skip("control_audit.claim_rejection table exists", async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'control_audit'
        AND table_name   = 'claim_rejection'
    `);
    assert.equal(rows.length, 1, "control_audit.claim_rejection table not found");
  });

  skip("claim_rejection has all required columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'control_audit'
        AND table_name   = 'claim_rejection'
        AND column_name  IN ('id', 'dispatch_id', 'agency_id', 'reason_class', 'reason_detail', 'rejected_at')
    `);
    assert.equal(rows.length, 6, `Expected 6 columns, got: ${rows.map(r => r.column_name).join(", ")}`);
  });

  skip("reason_class CHECK constraint rejects unknown values", async () => {
    await assert.rejects(
      () => pool.query(`
        INSERT INTO control_audit.claim_rejection
          (agency_id, reason_class, reason_detail)
        VALUES (1, 'INVALID_REASON', 'test')
      `),
      /check.*violation|constraint/i,
      "Expected CHECK violation on unknown reason_class"
    );
  });

  skip("all valid reason_class values are accepted", async () => {
    const classes = [
      'MISSING_CAPABILITY', 'MISSING_SCOPE', 'UNKNOWN_SCOPE',
      'EXPIRED_LEASE', 'AMBIGUOUS_ROUTE', 'POLICY_VIOLATION',
      'INACTIVE_AGENCY', 'ROUTE_DISABLED', 'BUDGET_EXHAUSTED',
      'CONCURRENCY_EXCEEDED',
    ];

    const insertedIds: number[] = [];
    for (const cls of classes) {
      const { rows } = await pool.query<{ id: number }>(`
        INSERT INTO control_audit.claim_rejection (agency_id, reason_class)
        VALUES (1, $1)
        RETURNING id
      `, [cls]);
      insertedIds.push(rows[0].id);
    }

    // Cleanup
    await pool.query(
      "DELETE FROM control_audit.claim_rejection WHERE id = ANY($1)",
      [insertedIds]
    );
  });
});

// ─── AC-4: INACTIVE_AGENCY rejection is logged ────────────────────────────────

describe("AC-4: fn_claim_work_offer logs INACTIVE_AGENCY when agency status != active", () => {
  skip("inactive agency gets INACTIVE_AGENCY rejection logged", async () => {
    const scratchId = `p438-inactive-${Date.now()}`;

    let agentDbId: number | undefined;
    try {
      const { rows: insertRows } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, status, availability, capabilities, model, provider, cost_class)
        VALUES ($1, 'agency', 'paused', 'idle', '[]', 'test-model', 'test-provider', 'low')
        RETURNING id
      `, [scratchId]);
      agentDbId = insertRows[0].id;

      const rejectionsBefore = await pool.query<{ count: string }>(`
        SELECT COUNT(*) AS count FROM control_audit.claim_rejection WHERE agency_id = $1
      `, [agentDbId]);

      // Call fn_claim_work_offer — agency is paused, should trigger INACTIVE_AGENCY gate
      const { rows: claimRows } = await pool.query(`
        SELECT * FROM roadmap_workforce.fn_claim_work_offer($1)
      `, [scratchId]);

      assert.equal(claimRows.length, 0, "Expected 0 rows from inactive agency claim");

      const { rows: rejections } = await pool.query<{ reason_class: string }>(`
        SELECT reason_class FROM control_audit.claim_rejection
        WHERE agency_id = $1
        ORDER BY rejected_at DESC
        LIMIT 1
      `, [agentDbId]);

      assert.equal(rejections.length, 1, "Expected a claim_rejection row to be inserted");
      assert.equal(rejections[0].reason_class, "INACTIVE_AGENCY",
        `Expected INACTIVE_AGENCY, got ${rejections[0].reason_class}`);
    } finally {
      if (agentDbId) {
        await pool.query(
          "DELETE FROM control_audit.claim_rejection WHERE agency_id = $1",
          [agentDbId]
        );
        await pool.query(
          "DELETE FROM roadmap_workforce.agent_registry WHERE id = $1",
          [agentDbId]
        );
      }
    }
  });
});

// ─── AC-4: MISSING_SCOPE rejection is logged ──────────────────────────────────

describe("AC-4: fn_claim_work_offer logs MISSING_SCOPE for agency with no provider_registry", () => {
  skip("agency with no provider_registry rows gets MISSING_SCOPE logged", async () => {
    const scratchId = `p438-noscope-${Date.now()}`;

    let agentDbId: number | undefined;
    try {
      const { rows: insertRows } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, status, availability, capabilities, model, provider, cost_class)
        VALUES ($1, 'agency', 'active', 'idle', '[]', 'test-model', 'test-provider', 'low')
        RETURNING id
      `, [scratchId]);
      agentDbId = insertRows[0].id;

      // Call fn_claim_work_offer — no provider_registry rows, should trigger MISSING_SCOPE
      const { rows: claimRows } = await pool.query(`
        SELECT * FROM roadmap_workforce.fn_claim_work_offer($1)
      `, [scratchId]);

      assert.equal(claimRows.length, 0, "Expected 0 rows from agency with no provider_registry");

      const { rows: rejections } = await pool.query<{ reason_class: string }>(`
        SELECT reason_class FROM control_audit.claim_rejection
        WHERE agency_id = $1
        ORDER BY rejected_at DESC
        LIMIT 1
      `, [agentDbId]);

      assert.equal(rejections.length, 1, "Expected a claim_rejection row");
      assert.equal(rejections[0].reason_class, "MISSING_SCOPE",
        `Expected MISSING_SCOPE, got ${rejections[0].reason_class}`);
    } finally {
      if (agentDbId) {
        await pool.query(
          "DELETE FROM control_audit.claim_rejection WHERE agency_id = $1",
          [agentDbId]
        );
        await pool.query(
          "DELETE FROM roadmap_workforce.agent_registry WHERE id = $1",
          [agentDbId]
        );
      }
    }
  });
});

// ─── Migration state: capabilities migrated correctly ─────────────────────────

describe("Migration: non-terminal required_capabilities rows are valid arrays", () => {
  skip("no open/claimed/active dispatch rows have invalid required_capabilities", async () => {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM roadmap_workforce.squad_dispatch
      WHERE offer_status IN ('open', 'claimed', 'active')
        AND (
          required_capabilities IS NULL
          OR jsonb_typeof(required_capabilities) != 'array'
          OR jsonb_array_length(required_capabilities) = 0
        )
    `);
    assert.equal(rows[0].count, "0",
      `${rows[0].count} non-terminal rows have invalid required_capabilities after migration`);
  });

  skip("agent_registry has max_concurrent_claims column", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap_workforce'
        AND table_name   = 'agent_registry'
        AND column_name  = 'max_concurrent_claims'
    `);
    assert.equal(rows.length, 1, "max_concurrent_claims column missing from agent_registry");
  });
});
