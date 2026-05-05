/**
 * AC-9: workflow_active.workflow_template_copy stores states+gates
 *       at pin time. Subsequent template updates do NOT affect existing snapshots.
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

const NS = 'snap';

describe('P598 snapshot isolation tests', () => {
  const pool = createPool();

  before(async () => {
    await bootstrapTemplateNamespace(pool, NS);
    await bootstrapWorkflowActiveNamespace(pool, NS);

    await pool.query(
      `INSERT INTO tmpl_${NS}.workflow_template
         (template_id, family, version, display_name, states, gates, owner_did)
       VALUES ('rfc-5-stage@v1', 'rfc-5-stage', 1, 'Standard RFC', $1::jsonb, $2::jsonb, 'did:system:test')`,
      [RFC5_STATES, RFC5_GATES],
    );

    // Pin the template to project 42
    await pool.query(
      `INSERT INTO wact_${NS}.workflow_template_copy
         (project_id, template_id, family, version, display_name, states, gates)
       SELECT 42, t.template_id, t.family, t.version, t.display_name, t.states, t.gates
       FROM tmpl_${NS}.workflow_template t
       WHERE t.template_id = 'rfc-5-stage@v1'`,
    );
  });

  after(async () => {
    await teardownTemplateNamespace(pool, NS);
    await pool.end();
  });

  it('AC-9: snapshot row exists for project 42 with correct state count', async () => {
    const { rows } = await pool.query(
      `SELECT jsonb_array_length(states) AS sc, jsonb_array_length(gates) AS gc
       FROM wact_${NS}.workflow_template_copy
       WHERE project_id = 42 AND template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows.length, 1, 'snapshot row must exist');
    assert.equal(rows[0].sc, 5, 'snapshot must have 5 states');
    assert.equal(rows[0].gc, 7, 'snapshot must have 7 gates');
  });

  it('AC-9: snapshot row has pinned_at timestamp', async () => {
    const { rows } = await pool.query(
      `SELECT pinned_at FROM wact_${NS}.workflow_template_copy
       WHERE project_id = 42 AND template_id = 'rfc-5-stage@v1'`,
    );
    assert.ok(rows[0].pinned_at instanceof Date, 'pinned_at must be a Date');
  });

  it('AC-9: snapshot survives non-structural template update (display_name change)', async () => {
    // Updating display_name on source template does NOT cascade to snapshot
    await pool.query(
      `UPDATE tmpl_${NS}.workflow_template
       SET display_name = 'Renamed Template'
       WHERE template_id = 'rfc-5-stage@v1'`,
    );

    // Snapshot still has original display_name (point-in-time copy)
    const { rows } = await pool.query(
      `SELECT display_name FROM wact_${NS}.workflow_template_copy
       WHERE project_id = 42 AND template_id = 'rfc-5-stage@v1'`,
    );
    // display_name in snapshot was set at pin time; it won't auto-update
    assert.equal(rows[0].display_name, 'Standard RFC');
  });
});
