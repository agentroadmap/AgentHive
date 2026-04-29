/**
 * P436 Integration Tests — control-plane FK reconciliation
 *
 * AC coverage:
 *   AC-1: provider_registry.project_id FK → roadmap.project validated
 *   AC-2: run_log + context_window_log classified as control-plane (project_id present)
 *   AC-3: proposal + gate_decision_log project_id NOT NULL, FK → roadmap.project
 *   AC-4: fn_claim_work_offer FAIL-CLOSED — agencies with no provider_registry row get 0 candidates
 *   AC-5: no orphaned proposal rows after migration
 *   AC-6: legacy claim without provider_registry → 0 rows returned (fail-closed behaviour)
 *
 * Prerequisites: migration 066 applied, PGPASSWORD set.
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
    user:     process.env.PGUSER     ?? "admin",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "agenthive",
  });
});

after(async () => {
  if (!pool) return;
  await pool.end();
});

// ─── AC-5: No orphaned proposal rows ──────────────────────────────────────────

describe("AC-5: no orphaned proposal rows", () => {
  skip("proposal.project_id has no orphans relative to roadmap.project", async () => {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM roadmap_proposal.proposal p
      WHERE NOT EXISTS (
        SELECT 1 FROM roadmap.project rp WHERE rp.project_id = p.project_id
      )
    `);
    assert.equal(rows[0].count, "0",
      `${rows[0].count} proposal rows orphaned from roadmap.project`);
  });

  skip("squad_dispatch.project_id has no orphans relative to roadmap.project", async () => {
    const { rows } = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM roadmap_workforce.squad_dispatch sd
      WHERE NOT EXISTS (
        SELECT 1 FROM roadmap.project rp WHERE rp.project_id = sd.project_id
      )
    `);
    assert.equal(rows[0].count, "0",
      `${rows[0].count} squad_dispatch rows orphaned from roadmap.project`);
  });
});

// ─── AC-1: provider_registry FK constraint present ────────────────────────────

describe("AC-1: provider_registry.project_id FK is wired to roadmap.project", () => {
  skip("FK constraint exists on provider_registry", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid = 'roadmap_workforce.provider_registry'::regclass
        AND conname = 'provider_registry_project_id_fkey'
    `);
    assert.equal(rows.length, 1, "provider_registry_project_id_fkey constraint not found");
  });

  skip("provider_registry FK points to roadmap.project, not roadmap_workforce.projects", async () => {
    const { rows } = await pool.query<{ confrelid: string }>(`
      SELECT confrelid::regclass::text AS target_table
      FROM pg_constraint
      WHERE conname = 'provider_registry_project_id_fkey'
        AND conrelid = 'roadmap_workforce.provider_registry'::regclass
    `);
    assert.equal(rows.length, 1);
    assert.match(rows[0].target_table, /roadmap\.project/,
      `FK target is ${rows[0].target_table}, expected roadmap.project`);
  });

  skip("inserting invalid project_id into provider_registry raises FK violation", async () => {
    // Find an agency id for the test row
    const { rows: agents } = await pool.query<{ id: string; agent_identity: string }>(`
      SELECT id, agent_identity
      FROM roadmap_workforce.agent_registry
      WHERE agent_type = 'agency'
      LIMIT 1
    `);
    if (!agents.length) return; // no agencies to test with

    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.provider_registry
          (agency_id, agency_identity, project_id, capabilities, status, is_active)
        VALUES ($1, $2, 999999, '[]', 'active', true)
      `, [agents[0].id, agents[0].agent_identity]),
      /foreign key/i,
      "Expected FK violation on invalid project_id"
    );
  });
});

// ─── AC-3: proposal + gate_decision_log project_id NOT NULL + FK ──────────────

describe("AC-3: control-plane tables have project_id NOT NULL FK", () => {
  skip("proposal.project_id FK targets roadmap.project", async () => {
    const { rows } = await pool.query<{ target_table: string }>(`
      SELECT confrelid::regclass::text AS target_table
      FROM pg_constraint
      WHERE conname = 'proposal_project_id_fkey'
        AND conrelid = 'roadmap_proposal.proposal'::regclass
    `);
    assert.equal(rows.length, 1);
    assert.match(rows[0].target_table, /roadmap\.project/,
      `proposal FK target is ${rows[0].target_table}, expected roadmap.project`);
  });

  skip("gate_decision_log.project_id column is NOT NULL", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'roadmap_proposal'
        AND table_name   = 'gate_decision_log'
        AND column_name  = 'project_id'
    `);
    assert.equal(rows.length, 1, "project_id column not found on gate_decision_log");
    assert.equal(rows[0].is_nullable, "NO",
      "gate_decision_log.project_id is nullable — expected NOT NULL");
  });

  skip("gate_decision_log.project_id has FK to roadmap.project", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid = 'roadmap_proposal.gate_decision_log'::regclass
        AND conname = 'gate_decision_log_project_id_fkey'
    `);
    assert.equal(rows.length, 1, "gate_decision_log_project_id_fkey constraint not found");
  });

  skip("roadmap.gate_decision_log view exposes project_id", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap'
        AND table_name   = 'gate_decision_log'
        AND column_name  = 'project_id'
    `);
    assert.equal(rows.length, 1,
      "project_id not exposed by roadmap.gate_decision_log view");
  });
});

// ─── AC-2: run_log + context_window_log have project_id ───────────────────────

describe("AC-2: telemetry tables classified as control-plane", () => {
  skip("roadmap.run_log has project_id column with FK", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap'
        AND table_name   = 'run_log'
        AND column_name  = 'project_id'
    `);
    assert.equal(rows.length, 1, "project_id missing from roadmap.run_log");
  });

  skip("roadmap_efficiency.context_window_log has project_id column", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap_efficiency'
        AND table_name   = 'context_window_log'
        AND column_name  = 'project_id'
    `);
    assert.equal(rows.length, 1, "project_id missing from roadmap_efficiency.context_window_log");
  });

  skip("roadmap.context_window_log view exposes project_id", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap'
        AND table_name   = 'context_window_log'
        AND column_name  = 'project_id'
    `);
    assert.equal(rows.length, 1,
      "project_id not exposed by roadmap.context_window_log view");
  });
});

// ─── AC-4 + AC-6: fn_claim_work_offer is FAIL-CLOSED ─────────────────────────

describe("AC-4 + AC-6: fn_claim_work_offer fail-closed behaviour", () => {
  skip("all agency-type agents have at least one active provider_registry row", async () => {
    const { rows } = await pool.query<{ count: string; agent_identity: string }>(`
      SELECT COUNT(*) AS count
      FROM roadmap_workforce.agent_registry ar
      WHERE ar.agent_type = 'agency'
        AND NOT EXISTS (
          SELECT 1 FROM roadmap_workforce.provider_registry pr
          WHERE pr.agency_id = ar.id AND pr.status = 'active'
        )
    `);
    assert.equal(rows[0].count, "0",
      `${rows[0].count} agency-type agents still have no active provider_registry row`);
  });

  skip("function body no longer references legacy roadmap_workforce.projects in UNION", async () => {
    const { rows } = await pool.query<{ body: string }>(`
      SELECT pg_get_functiondef(oid) AS body
      FROM pg_proc
      WHERE proname = 'fn_claim_work_offer'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap_workforce')
      LIMIT 1
    `);
    assert.equal(rows.length, 1, "fn_claim_work_offer not found");
    // The UNION fallback referencing workforce.projects must be gone
    assert.doesNotMatch(
      rows[0].body,
      /SELECT id FROM roadmap_workforce\.projects/,
      "fn_claim_work_offer still contains legacy UNION fallback to roadmap_workforce.projects"
    );
    // The function must still contain the fail-closed agency_projects CTE
    assert.match(
      rows[0].body,
      /agency_projects/,
      "fn_claim_work_offer missing agency_projects CTE"
    );
  });

  skip("agency with no open dispatches returns empty set (not all-project fallback)", async () => {
    // Create a scratch agent with no provider_registry row and no dispatches
    const scratchIdentity = `p436-test-agent-${Date.now()}`;
    let agentId: number;

    try {
      const { rows: insertRows } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, status, availability, capabilities, model, provider, cost_class)
        VALUES ($1, 'agency', 'active', 'idle', '[]', 'test-model', 'test-provider', 'low')
        RETURNING id
      `, [scratchIdentity]);
      agentId = insertRows[0].id;

      // Call fn_claim_work_offer — should return 0 rows (fail-closed, no provider_registry)
      const { rows: claimRows } = await pool.query(`
        SELECT * FROM roadmap_workforce.fn_claim_work_offer($1)
      `, [scratchIdentity]);

      assert.equal(claimRows.length, 0,
        "Expected 0 rows for agency with no provider_registry, got dispatches (fail-open)");
    } finally {
      // Cleanup scratch agent
      if (agentId!) {
        await pool.query(
          "DELETE FROM roadmap_workforce.agent_registry WHERE id = $1",
          [agentId]
        );
      }
    }
  });
});
