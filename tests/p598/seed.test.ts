/**
 * AC-5: rfc-5-stage@v1 seed row is present with 5 states and 7 gates
 * AC-6: lightweight-3-stage@v1 seed row is present with 3 states and 3 gates
 * AC-12: owner_did = 'did:system:agenthive' for all seeded rows
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPool } from './helpers.js';

describe('P598 seed tests (live DB)', () => {
  let pool: Pool;

  before(() => {
    pool = createPool();
  });

  after(async () => {
    await pool.end();
  });

  it('AC-5: rfc-5-stage@v1 exists with 5 states and 7 gates', async () => {
    const { rows } = await pool.query(
      `SELECT template_id, family, version,
              jsonb_array_length(states) AS state_count,
              jsonb_array_length(gates)  AS gate_count,
              owner_did, lifecycle_status
       FROM template.workflow_template
       WHERE template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows.length, 1, 'rfc-5-stage@v1 must exist in template.workflow_template');
    assert.equal(rows[0].state_count, 5, 'rfc-5-stage@v1 must have 5 states');
    assert.equal(rows[0].gate_count,  7, 'rfc-5-stage@v1 must have 7 gates');
    assert.equal(rows[0].lifecycle_status, 'active');
  });

  it('AC-6: lightweight-3-stage@v1 exists with 3 states and 3 gates', async () => {
    const { rows } = await pool.query(
      `SELECT template_id,
              jsonb_array_length(states) AS state_count,
              jsonb_array_length(gates)  AS gate_count,
              owner_did, lifecycle_status
       FROM template.workflow_template
       WHERE template_id = 'lightweight-3-stage@v1'`,
    );
    assert.equal(rows.length, 1, 'lightweight-3-stage@v1 must exist');
    assert.equal(rows[0].state_count, 3, 'lightweight-3-stage@v1 must have 3 states');
    assert.equal(rows[0].gate_count,  3, 'lightweight-3-stage@v1 must have 3 gates');
    assert.equal(rows[0].lifecycle_status, 'active');
  });

  it('AC-12: all seeded templates have owner_did = did:system:agenthive', async () => {
    const { rows } = await pool.query(
      `SELECT template_id, owner_did
       FROM template.workflow_template
       WHERE template_id IN ('rfc-5-stage@v1', 'lightweight-3-stage@v1')`,
    );
    assert.equal(rows.length, 2, 'Both seed rows must be present');
    for (const row of rows) {
      assert.equal(
        row.owner_did,
        'did:system:agenthive',
        `${row.template_id} must have owner_did = did:system:agenthive`,
      );
    }
  });
});
