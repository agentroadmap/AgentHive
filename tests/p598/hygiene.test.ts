/**
 * AC-7: lifecycle_status transitions — deprecate and retire flow.
 *       active → deprecated → retired (skip not allowed)
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

const NS = 'hyg';

describe('P598 lifecycle hygiene tests', () => {
  const pool = createPool();

  before(async () => {
    await bootstrapTemplateNamespace(pool, NS);
    await pool.query(
      `INSERT INTO tmpl_${NS}.workflow_template
         (template_id, family, version, display_name, states, gates, owner_did)
       VALUES ('rfc-5-stage@v1', 'rfc-5-stage', 1, 'Standard RFC', $1::jsonb, $2::jsonb, 'did:system:test'),
              ('rfc-5-stage@v2', 'rfc-5-stage', 2, 'Standard RFC v2', $1::jsonb, $2::jsonb, 'did:system:test')`,
      [RFC5_STATES, RFC5_GATES],
    );
  });

  after(async () => {
    await teardownTemplateNamespace(pool, NS);
    await pool.end();
  });

  it('AC-7: initial lifecycle_status is active', async () => {
    const { rows } = await pool.query(
      `SELECT lifecycle_status FROM tmpl_${NS}.workflow_template WHERE template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows[0].lifecycle_status, 'active');
  });

  it('AC-7: CHECK constraint rejects invalid lifecycle_status', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE tmpl_${NS}.workflow_template
         SET lifecycle_status = 'invalid_state'
         WHERE template_id = 'rfc-5-stage@v1'`,
      ),
      /check/i,
    );
  });

  it('AC-7: active → deprecated transition sets deprecated_at', async () => {
    await pool.query(
      `UPDATE tmpl_${NS}.workflow_template
       SET lifecycle_status = 'deprecated', deprecated_at = now()
       WHERE template_id = 'rfc-5-stage@v1'`,
    );
    const { rows } = await pool.query(
      `SELECT lifecycle_status, deprecated_at FROM tmpl_${NS}.workflow_template
       WHERE template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows[0].lifecycle_status, 'deprecated');
    assert.ok(rows[0].deprecated_at != null, 'deprecated_at must be set');
  });

  it('AC-7: deprecated → retired transition is allowed', async () => {
    await assert.doesNotReject(
      pool.query(
        `UPDATE tmpl_${NS}.workflow_template
         SET lifecycle_status = 'retired'
         WHERE template_id = 'rfc-5-stage@v1'`,
      ),
    );
    const { rows } = await pool.query(
      `SELECT lifecycle_status FROM tmpl_${NS}.workflow_template WHERE template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows[0].lifecycle_status, 'retired');
  });

  it('AC-7: listTemplates by status returns only matching rows', async () => {
    // rfc-5-stage@v1 is retired, rfc-5-stage@v2 is active
    const { rows: active } = await pool.query(
      `SELECT template_id FROM tmpl_${NS}.workflow_template WHERE lifecycle_status = 'active'`,
    );
    const ids = active.map((r: { template_id: string }) => r.template_id);
    assert.ok(ids.includes('rfc-5-stage@v2'), 'v2 must be active');
    assert.ok(!ids.includes('rfc-5-stage@v1'), 'v1 must not be in active results');

    const { rows: retired } = await pool.query(
      `SELECT template_id FROM tmpl_${NS}.workflow_template WHERE lifecycle_status = 'retired'`,
    );
    assert.ok(retired.some((r: { template_id: string }) => r.template_id === 'rfc-5-stage@v1'));
  });
});
