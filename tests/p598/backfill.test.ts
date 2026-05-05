/**
 * AC-10: Backfill inference logic.
 *        Projects with RFC-style proposal states → assigned rfc-5-stage@v1.
 *        Projects with no matching states → logged to template_backfill_orphans.
 *
 * This test runs against a stub project schema to validate the backfill SQL logic
 * without touching the live roadmap data.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPool,
  bootstrapTemplateNamespace,
  teardownTemplateNamespace,
  RFC5_STATES,
  RFC5_GATES,
} from './helpers.js';

const NS = 'bfill';

describe('P598 backfill inference tests', () => {
  const pool = createPool();

  before(async () => {
    await bootstrapTemplateNamespace(pool, NS);

    // Seed the reference template
    await pool.query(
      `INSERT INTO tmpl_${NS}.workflow_template
         (template_id, family, version, display_name, states, gates, owner_did)
       VALUES ('rfc-5-stage@v1', 'rfc-5-stage', 1, 'Standard RFC', $1::jsonb, $2::jsonb, 'did:system:agenthive')`,
      [RFC5_STATES, RFC5_GATES],
    );

    // Create stub project + proposal tables for backfill logic testing
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS proj_${NS};

      CREATE TABLE proj_${NS}.project (
        project_id  BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        slug        TEXT   NOT NULL UNIQUE,
        template_id TEXT   REFERENCES tmpl_${NS}.workflow_template(template_id)
                           ON UPDATE RESTRICT ON DELETE RESTRICT
      );

      CREATE TABLE proj_${NS}.proposal (
        proposal_id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id  BIGINT NOT NULL REFERENCES proj_${NS}.project(project_id),
        status      TEXT   NOT NULL
      );

      -- orphan log table (mirrors template_backfill_orphans structure)
      CREATE TABLE IF NOT EXISTS tmpl_${NS}.template_backfill_orphans (
        project_id      BIGINT      NOT NULL PRIMARY KEY,
        project_slug    TEXT,
        detected_states TEXT[]      NOT NULL DEFAULT '{}',
        logged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        notes           TEXT
      );
    `);

    // Seed projects and proposals
    await pool.query(`
      -- Project 1: has RFC-style proposals → should get rfc-5-stage@v1
      INSERT INTO proj_${NS}.project (slug) VALUES ('rfc-project');
      INSERT INTO proj_${NS}.proposal (project_id, status) VALUES
        (1, 'Draft'), (1, 'Review'), (1, 'Develop');

      -- Project 2: has unknown states → should become orphan
      INSERT INTO proj_${NS}.project (slug) VALUES ('orphan-project');
      INSERT INTO proj_${NS}.proposal (project_id, status) VALUES
        (2, 'TRIAGE'), (2, 'FIX');

      -- Project 3: no proposals → orphan
      INSERT INTO proj_${NS}.project (slug) VALUES ('empty-project');
    `);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS proj_${NS} CASCADE;`);
    await teardownTemplateNamespace(pool, NS);
    await pool.end();
  });

  it('AC-10: projects with RFC-style states get assigned rfc-5-stage@v1', async () => {
    // Run backfill for RFC projects
    await pool.query(`
      UPDATE proj_${NS}.project p
      SET template_id = 'rfc-5-stage@v1'
      WHERE p.template_id IS NULL
        AND EXISTS (
          SELECT 1 FROM proj_${NS}.proposal pr
          WHERE pr.project_id = p.project_id
            AND pr.status IN ('Draft','Review','Develop','Merge','Complete')
        )
    `);

    const { rows } = await pool.query(
      `SELECT slug, template_id FROM proj_${NS}.project WHERE project_id = 1`,
    );
    assert.equal(rows[0].template_id, 'rfc-5-stage@v1', 'RFC project must be assigned rfc-5-stage@v1');
  });

  it('AC-10: projects without RFC-style states are logged as orphans', async () => {
    // Log orphans (projects with no template_id after RFC assignment)
    await pool.query(`
      INSERT INTO tmpl_${NS}.template_backfill_orphans (project_id, project_slug, detected_states, notes)
      SELECT
        p.project_id,
        p.slug,
        COALESCE(
          ARRAY(SELECT DISTINCT pr.status FROM proj_${NS}.proposal pr WHERE pr.project_id = p.project_id),
          '{}' ::TEXT[]
        ),
        'test backfill: no matching template'
      FROM proj_${NS}.project p
      WHERE p.template_id IS NULL
      ON CONFLICT (project_id) DO NOTHING
    `);

    const { rows } = await pool.query(
      `SELECT project_id, project_slug, detected_states
       FROM tmpl_${NS}.template_backfill_orphans
       ORDER BY project_id`,
    );
    assert.ok(rows.length >= 2, 'Both orphan projects must be logged');
    const slugs = rows.map((r: { project_slug: string }) => r.project_slug);
    assert.ok(slugs.includes('orphan-project'), 'orphan-project must be in orphans table');
    assert.ok(slugs.includes('empty-project'), 'empty-project must be in orphans table');
  });

  it('AC-10: rfc-project is NOT in orphans table', async () => {
    const { rows } = await pool.query(
      `SELECT project_id FROM tmpl_${NS}.template_backfill_orphans WHERE project_id = 1`,
    );
    assert.equal(rows.length, 0, 'rfc-project must not appear in orphans (it was assigned)');
  });
});
