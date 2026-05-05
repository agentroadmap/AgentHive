/**
 * AC-4: workflow_active.workflow_template_copy FK to template.workflow_template
 *       — pinning a valid template succeeds; pinning an unknown template fails.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPool,
  bootstrapTemplateNamespace,
  bootstrapWorkflowActiveNamespace,
  teardownTemplateNamespace,
  RFC5_STATES,
  RFC5_GATES,
} from './helpers.js';

const NS = 'pin';

describe('P598 pin (workflow_active snapshot) tests', () => {
  const pool = createPool();

  before(async () => {
    await bootstrapTemplateNamespace(pool, NS);
    await bootstrapWorkflowActiveNamespace(pool, NS);

    // Seed a template to pin against
    await pool.query(
      `INSERT INTO tmpl_${NS}.workflow_template
         (template_id, family, version, display_name, states, gates, owner_did)
       VALUES ('rfc-5-stage@v1', 'rfc-5-stage', 1, 'Standard RFC', $1::jsonb, $2::jsonb, 'did:system:test')`,
      [RFC5_STATES, RFC5_GATES],
    );
  });

  after(async () => {
    await teardownTemplateNamespace(pool, NS);
    await pool.end();
  });

  it('AC-4: pinning a valid template_id into workflow_template_copy succeeds', async () => {
    await assert.doesNotReject(
      pool.query(
        `INSERT INTO wact_${NS}.workflow_template_copy
           (project_id, template_id, family, version, display_name, states, gates)
         SELECT 1, t.template_id, t.family, t.version, t.display_name, t.states, t.gates
         FROM tmpl_${NS}.workflow_template t
         WHERE t.template_id = 'rfc-5-stage@v1'`,
      ),
    );

    const { rows } = await pool.query(
      `SELECT project_id, template_id FROM wact_${NS}.workflow_template_copy WHERE project_id = 1`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].template_id, 'rfc-5-stage@v1');
  });

  it('AC-4: pinning an unknown template_id raises FK violation', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO wact_${NS}.workflow_template_copy
           (project_id, template_id, family, version, display_name, states, gates)
         VALUES (2, 'nonexistent@v99', 'nonexistent', 99, 'Bad', '[]'::jsonb, '[]'::jsonb)`,
      ),
      /foreign key/i,
    );
  });

  it('AC-4: snapshot row contains states and gates copied from template', async () => {
    const { rows } = await pool.query(
      `SELECT
         jsonb_array_length(states) AS state_count,
         jsonb_array_length(gates)  AS gate_count
       FROM wact_${NS}.workflow_template_copy
       WHERE project_id = 1 AND template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows[0].state_count, 5);
    assert.equal(rows[0].gate_count, 7);
  });
});
