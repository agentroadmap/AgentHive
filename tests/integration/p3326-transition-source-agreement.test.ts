/**
 * P3326 Integration Tests — gate/transition layer correctness
 *
 * AC-1: gate_decision D2 advance on a Standard RFC proposal in REVIEW resolves
 *       to_state=DEVELOP (not COMPLETE) via stage_order ranking.
 * AC-3: prop_transition REVIEW→DEVELOP succeeds for a feature proposal whose
 *       workflows row points to Standard RFC template (no ptc JOIN indirection).
 * AC-4: For every non-terminal workflow template, proposal_valid_transitions and
 *       workflow_stages agree — every to_state in pvt has a matching stage in ws,
 *       and stage_order is monotonically increasing along every valid path.
 *
 * Uses a real Postgres connection — no mocks.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

let pool: Pool;

async function cleanup(pool: Pool, proposalId: number) {
  await pool.query(
    `DELETE FROM roadmap_proposal.gate_decision_log WHERE proposal_id = $1`,
    [proposalId],
  );
  await pool.query(
    `DELETE FROM roadmap.workflows WHERE proposal_id = $1`,
    [proposalId],
  );
  await pool.query(
    `DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
    [proposalId],
  );
}

async function insertStandardRfcProposal(
  pool: Pool,
  status: string,
): Promise<{ proposalId: number; templateId: number }> {
  const displayId = `P3326-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const { rows: propRows } = await pool.query<{ id: number }>(
    `INSERT INTO roadmap_proposal.proposal
         (display_id, title, status, maturity, type, project_id, audit)
     VALUES ($1, $2, $3, 'active', 'feature', 1,
             '{"created_by":"p3326-test","created_at":"2026-01-01"}'::jsonb)
     RETURNING id`,
    [displayId, `P3326 test ${displayId}`, status],
  );
  const proposalId = propRows[0]!.id;

  // Resolve Standard RFC template id
  const { rows: tmplRows } = await pool.query<{ id: number }>(
    `SELECT id FROM roadmap.workflow_templates WHERE LOWER(name) = 'standard rfc' LIMIT 1`,
  );
  assert.ok(tmplRows.length > 0, "Standard RFC workflow_template must exist");
  const templateId = tmplRows[0]!.id;

  // Insert matching workflows row (Standard RFC)
  await pool.query(
    `INSERT INTO roadmap.workflows (proposal_id, template_id, current_stage, type)
     VALUES ($1, $2, $3, 'feature')
     ON CONFLICT (proposal_id) DO UPDATE SET template_id = $2, current_stage = $3`,
    [proposalId, templateId, status],
  );

  return { proposalId, templateId };
}

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 3 });
  await pool.query("SELECT 1");
});

after(async () => {
  await pool.end();
});

describe("P3326: gate/transition source-of-truth correctness", () => {
  describe("AC-1: gate_decision D2 advance resolves DEVELOP (not COMPLETE)", () => {
    it("picks DEVELOP over COMPLETE via stage_order for Standard RFC in REVIEW", async () => {
      const { proposalId, templateId } = await insertStandardRfcProposal(
        pool,
        "REVIEW",
      );

      try {
        // Replicate the fixed advance-target query from pg-handlers.ts (rfc)
        const { rows: fwd } = await pool.query<{ to_state: string }>(
          `SELECT pvt.to_state
             FROM roadmap.workflows w
             JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
             JOIN roadmap_proposal.proposal_valid_transitions pvt
               ON pvt.workflow_name = wt.name
             JOIN roadmap.workflow_stages ws_to
               ON ws_to.template_id = wt.id
              AND LOWER(ws_to.stage_name) = LOWER(pvt.to_state)
             JOIN roadmap.workflow_stages ws_from
               ON ws_from.template_id = wt.id
              AND LOWER(ws_from.stage_name) = LOWER($2)
            WHERE w.proposal_id = $1
              AND LOWER(pvt.from_state) = LOWER($2)
              AND pvt.allowed_reasons && ARRAY['mature','decision','deploy','accepted','submit','approve','advance','quorum_met']::text[]
              AND ws_to.stage_order > ws_from.stage_order
            ORDER BY ws_to.stage_order ASC
            LIMIT 1`,
          [proposalId, "REVIEW"],
        );

        assert.ok(fwd.length > 0, "Should find a forward transition from REVIEW");
        assert.equal(
          fwd[0]!.to_state.toUpperCase(),
          "DEVELOP",
          `Expected DEVELOP but got ${fwd[0]!.to_state} — alphabetical ORDER BY bug not fixed`,
        );
      } finally {
        await cleanup(pool, proposalId);
      }
    });
  });

  describe("AC-3: prop_transition REVIEW→DEVELOP succeeds without ptc JOIN", () => {
    it("finds REVIEW→DEVELOP transition row via direct wt.name join", async () => {
      const { proposalId } = await insertStandardRfcProposal(pool, "REVIEW");

      try {
        // Replicate the fixed transitionProposal validation query from proposal-storage-v2.ts
        const { rows } = await pool.query(
          `SELECT 1
             FROM roadmap_proposal.proposal_valid_transitions pvt
             JOIN roadmap.workflows w ON w.proposal_id = $1
             JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
            WHERE pvt.workflow_name = wt.name
              AND LOWER(pvt.from_state) = LOWER($2)
              AND LOWER(pvt.to_state) = LOWER($3)
            LIMIT 1`,
          [proposalId, "REVIEW", "DEVELOP"],
        );

        assert.equal(
          rows.length,
          1,
          "REVIEW→DEVELOP must be found via wt.name join (not ptc indirection)",
        );
      } finally {
        await cleanup(pool, proposalId);
      }
    });

    it("Architecture RFC does NOT expose REVIEW→DEVELOP (preserves isolation)", async () => {
      const displayId = `P3326-arch-${Date.now()}`;
      const { rows: propRows } = await pool.query<{ id: number }>(
        `INSERT INTO roadmap_proposal.proposal
             (display_id, title, status, maturity, type, project_id, audit)
         VALUES ($1, $2, 'REVIEW', 'active', 'architecture', 1,
                 '{"created_by":"p3326-test","created_at":"2026-01-01"}'::jsonb)
         RETURNING id`,
        [displayId, `P3326 arch test ${displayId}`],
      );
      const proposalId = propRows[0]!.id;

      // Wire to Architecture RFC template
      const { rows: tmplRows } = await pool.query<{ id: number }>(
        `SELECT id FROM roadmap.workflow_templates WHERE LOWER(name) = 'architecture rfc' LIMIT 1`,
      );
      if (tmplRows.length > 0) {
        await pool.query(
          `INSERT INTO roadmap.workflows (proposal_id, template_id, current_stage, type)
           VALUES ($1, $2, 'REVIEW', 'architecture')
           ON CONFLICT (proposal_id) DO UPDATE SET template_id = $2, current_stage = 'REVIEW'`,
          [proposalId, tmplRows[0]!.id],
        );
      }

      try {
        const { rows } = await pool.query(
          `SELECT 1
             FROM roadmap_proposal.proposal_valid_transitions pvt
             JOIN roadmap.workflows w ON w.proposal_id = $1
             JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
            WHERE pvt.workflow_name = wt.name
              AND LOWER(pvt.from_state) = LOWER($2)
              AND LOWER(pvt.to_state) = LOWER($3)
            LIMIT 1`,
          [proposalId, "REVIEW", "DEVELOP"],
        );

        assert.equal(
          rows.length,
          0,
          "Architecture RFC must NOT have REVIEW→DEVELOP transition",
        );
      } finally {
        await cleanup(pool, proposalId);
      }
    });
  });

  describe("AC-4: proposal_valid_transitions and workflow_stages agree", () => {
    it("every pvt.to_state has a matching stage in workflow_stages for all templates", async () => {
      const { rows: mismatches } = await pool.query<{
        template_name: string;
        workflow_name: string;
        from_state: string;
        to_state: string;
      }>(
        `SELECT wt.name AS template_name, pvt.workflow_name, pvt.from_state, pvt.to_state
           FROM roadmap_proposal.proposal_valid_transitions pvt
           JOIN roadmap.workflow_templates wt ON LOWER(wt.name) = LOWER(pvt.workflow_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM roadmap.workflow_stages ws
             WHERE ws.template_id = wt.id
               AND LOWER(ws.stage_name) = LOWER(pvt.to_state)
          )
          ORDER BY wt.name, pvt.from_state, pvt.to_state`,
      );

      assert.equal(
        mismatches.length,
        0,
        `proposal_valid_transitions references stage names not in workflow_stages:\n${JSON.stringify(mismatches, null, 2)}`,
      );
    });

    it("every pvt.from_state also appears in workflow_stages for its template", async () => {
      const { rows: mismatches } = await pool.query<{
        template_name: string;
        from_state: string;
      }>(
        `SELECT wt.name AS template_name, pvt.from_state
           FROM roadmap_proposal.proposal_valid_transitions pvt
           JOIN roadmap.workflow_templates wt ON LOWER(wt.name) = LOWER(pvt.workflow_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM roadmap.workflow_stages ws
             WHERE ws.template_id = wt.id
               AND LOWER(ws.stage_name) = LOWER(pvt.from_state)
          )
          ORDER BY wt.name, pvt.from_state`,
      );

      assert.equal(
        mismatches.length,
        0,
        `proposal_valid_transitions references from_state names not in workflow_stages:\n${JSON.stringify(mismatches, null, 2)}`,
      );
    });

    it("to_state has higher stage_order than from_state for all forward transitions", async () => {
      const { rows: violations } = await pool.query<{
        template_name: string;
        from_state: string;
        to_state: string;
        from_order: number;
        to_order: number;
      }>(
        `SELECT wt.name AS template_name, pvt.from_state, pvt.to_state,
                ws_from.stage_order AS from_order, ws_to.stage_order AS to_order
           FROM roadmap_proposal.proposal_valid_transitions pvt
           JOIN roadmap.workflow_templates wt ON LOWER(wt.name) = LOWER(pvt.workflow_name)
           JOIN roadmap.workflow_stages ws_from
             ON ws_from.template_id = wt.id AND LOWER(ws_from.stage_name) = LOWER(pvt.from_state)
           JOIN roadmap.workflow_stages ws_to
             ON ws_to.template_id = wt.id AND LOWER(ws_to.stage_name) = LOWER(pvt.to_state)
          WHERE ws_to.stage_order <= ws_from.stage_order
            AND pvt.allowed_reasons && ARRAY['advance','mature','accept','quorum_met']::text[]
          ORDER BY wt.name, pvt.from_state`,
      );

      assert.equal(
        violations.length,
        0,
        `Forward advance transitions where to_state.stage_order <= from_state.stage_order (not truly forward):\n${JSON.stringify(violations, null, 2)}`,
      );
    });
  });
});
