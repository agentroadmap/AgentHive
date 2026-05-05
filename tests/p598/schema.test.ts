/**
 * AC-1: template_id CHECK constraint enforced
 * AC-2: UNIQUE(family, version) constraint enforced
 * AC-3: immutability trigger raises restrict_violation on states/gates change
 * AC-8: non-structural fields (display_name, notes) can be updated
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

const NS = 'sch';

describe('P598 schema tests', () => {
  const pool = createPool();

  before(async () => {
    await bootstrapTemplateNamespace(pool, NS);
  });

  after(async () => {
    await teardownTemplateNamespace(pool, NS);
    await pool.end();
  });

  async function insertTemplate(
    templateId: string,
    family: string,
    version: number,
    overrides: Record<string, unknown> = {},
  ) {
    const states = (overrides.states as string) ?? RFC5_STATES;
    const gates  = (overrides.gates  as string) ?? RFC5_GATES;
    return pool.query(
      `INSERT INTO tmpl_${NS}.workflow_template
         (template_id, family, version, display_name, states, gates, owner_did)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'did:system:test')`,
      [templateId, family, version, overrides.display_name ?? `Test ${version}`, states, gates],
    );
  }

  it('AC-1: valid template_id is accepted', async () => {
    await assert.doesNotReject(
      insertTemplate('rfc-5-stage@v1', 'rfc-5-stage', 1),
    );
  });

  it('AC-1: invalid template_id (uppercase) is rejected', async () => {
    await assert.rejects(
      insertTemplate('RFC-5-Stage@v1', 'rfc-5-stage', 99),
      /check/i,
    );
  });

  it('AC-1: invalid template_id (missing @v) is rejected', async () => {
    await assert.rejects(
      insertTemplate('rfc-5-stage-v1', 'rfc-5-stage', 99),
      /check/i,
    );
  });

  it('AC-1: invalid template_id (version 0) is rejected', async () => {
    await assert.rejects(
      insertTemplate('rfc-5-stage@v0', 'rfc-5-stage', 99),
      /check/i,
    );
  });

  it('AC-2: duplicate family+version is rejected', async () => {
    // rfc-5-stage@v1 already inserted above (family='rfc-5-stage', version=1).
    // Use a valid template_id but same (family, version) to trigger UNIQUE constraint.
    await assert.rejects(
      pool.query(
        `INSERT INTO tmpl_${NS}.workflow_template
           (template_id, family, version, display_name, states, gates, owner_did)
         VALUES ('rfc-5-stage@v10', 'rfc-5-stage', 1, 'Dup', $1::jsonb, $2::jsonb, 'did:test')`,
        [RFC5_STATES, RFC5_GATES],
      ),
      (err: Error) => {
        assert.ok(
          /unique/i.test(err.message) || /duplicate/i.test(err.message),
          `Expected unique/duplicate violation, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('AC-3: updating states raises restrict_violation (SQLSTATE 23001)', async () => {
    const newStates = JSON.stringify([{ name: 'Draft', order: 1 }]);
    await assert.rejects(
      pool.query(
        `UPDATE tmpl_${NS}.workflow_template
         SET states = $1::jsonb
         WHERE template_id = 'rfc-5-stage@v1'`,
        [newStates],
      ),
      (err: Error & { code?: string }) => {
        assert.ok(
          err.code === '23001' ||
          err.message.includes('immutable') ||
          err.message.includes('restrict'),
          `Expected restrict_violation, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('AC-3: updating gates raises restrict_violation (SQLSTATE 23001)', async () => {
    const newGates = JSON.stringify([{ from: 'Draft', to: 'Complete' }]);
    await assert.rejects(
      pool.query(
        `UPDATE tmpl_${NS}.workflow_template
         SET gates = $1::jsonb
         WHERE template_id = 'rfc-5-stage@v1'`,
        [newGates],
      ),
      (err: Error & { code?: string }) => {
        assert.ok(
          err.code === '23001' ||
          err.message.includes('immutable'),
          `Expected restrict_violation, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('AC-8: non-structural fields (display_name, notes) can be updated freely', async () => {
    await assert.doesNotReject(
      pool.query(
        `UPDATE tmpl_${NS}.workflow_template
         SET display_name = 'Updated Name', notes = 'test note'
         WHERE template_id = 'rfc-5-stage@v1'`,
      ),
    );
    const { rows } = await pool.query(
      `SELECT display_name, notes FROM tmpl_${NS}.workflow_template
       WHERE template_id = 'rfc-5-stage@v1'`,
    );
    assert.equal(rows[0].display_name, 'Updated Name');
    assert.equal(rows[0].notes, 'test note');
  });
});
