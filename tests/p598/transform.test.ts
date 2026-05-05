/**
 * AC-11: smdlToTemplate() correctly transforms the 3 built-in SMDL workflows.
 *        rfc-5  → 5 states, 7 gates
 *        hotfix → 6 states, 6 gates
 *        quick-fix → 5 states, 5 gates
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { smdlToTemplate, smdlIdToTemplateId } from '../../src/core/workflow/smdl-to-template.ts';
import type { SMDLRoot } from '../../src/core/workflow/smdl-loader.ts';

// ─── Inline SMDL fixtures (mirrors builtins in smdl-loader.ts) ───────────────

const RFC5: SMDLRoot = {
  workflow: {
    id: 'rfc-5',
    name: 'Standard RFC',
    description: '5-stage RFC pipeline',
    version: '1.0.0',
    start_stage: 'DRAFT',
    terminal_stages: ['COMPLETE'],
    default_maturity_gate: 2,
    roles: [{ name: 'any', clearance: 1, is_default: true }],
    stages: [
      { name: 'DRAFT',    order: 1 },
      { name: 'REVIEW',   order: 2 },
      { name: 'DEVELOP',  order: 3 },
      { name: 'MERGE',    order: 4 },
      { name: 'COMPLETE', order: 5 },
    ],
    transitions: [
      { from: 'DRAFT',   to: 'REVIEW',   labels: ['mature'], allowed_roles: ['any'] },
      { from: 'REVIEW',  to: 'DEVELOP',  labels: ['mature'], allowed_roles: ['any'], requires_ac: true },
      { from: 'DEVELOP', to: 'MERGE',    labels: ['mature'], allowed_roles: ['any'], requires_ac: true },
      { from: 'MERGE',   to: 'COMPLETE', labels: ['mature'], allowed_roles: ['any'], requires_ac: true },
      { from: 'REVIEW',  to: 'DRAFT',    labels: ['iterate'], allowed_roles: ['any'] },
      { from: 'DEVELOP', to: 'REVIEW',   labels: ['iterate'], allowed_roles: ['any'] },
      { from: 'MERGE',   to: 'DEVELOP',  labels: ['iterate'], allowed_roles: ['any'] },
    ],
  },
};

const HOTFIX: SMDLRoot = {
  workflow: {
    id: 'hotfix',
    name: 'Hotfix',
    version: '1.0.0',
    start_stage: 'TRIAGE',
    terminal_stages: ['DEPLOYED', 'WONT_FIX', 'NON_ISSUE'],
    default_maturity_gate: 1,
    roles: [{ name: 'any', clearance: 1, is_default: true }],
    stages: [
      { name: 'TRIAGE',    order: 1 },
      { name: 'FIX',       order: 2, timeout: '4h' },
      { name: 'DEPLOYED',  order: 3 },
      { name: 'ESCALATE',  order: 90 },
      { name: 'WONT_FIX',  order: 97 },
      { name: 'NON_ISSUE', order: 98 },
    ],
    transitions: [
      { from: 'TRIAGE',  to: 'FIX',      labels: ['mature'],  allowed_roles: ['any'] },
      { from: 'TRIAGE',  to: 'WONT_FIX', labels: ['reject'],  allowed_roles: ['Lead'] },
      { from: 'TRIAGE',  to: 'NON_ISSUE', labels: ['reject'], allowed_roles: ['Lead'] },
      { from: 'FIX',     to: 'DEPLOYED', labels: ['mature'],  allowed_roles: ['any'], requires_ac: true },
      { from: 'FIX',     to: 'TRIAGE',   labels: ['iterate'], allowed_roles: ['Lead'] },
      { from: 'FIX',     to: 'ESCALATE', labels: ['timeout'], allowed_roles: ['any'] },
    ],
  },
};

const QUICKFIX: SMDLRoot = {
  workflow: {
    id: 'quick-fix',
    name: 'Quick Fix',
    version: '1.0.0',
    start_stage: 'TRIAGE',
    terminal_stages: ['DEPLOYED', 'WONT_FIX'],
    default_maturity_gate: 1,
    roles: [{ name: 'any', clearance: 1, is_default: true }],
    stages: [
      { name: 'TRIAGE',   order: 1 },
      { name: 'FIX',      order: 2, timeout: '4h' },
      { name: 'DEPLOYED', order: 3 },
      { name: 'ESCALATE', order: 90 },
      { name: 'WONT_FIX', order: 97 },
    ],
    transitions: [
      { from: 'TRIAGE',  to: 'FIX',      labels: ['mature'],  allowed_roles: ['any'] },
      { from: 'TRIAGE',  to: 'WONT_FIX', labels: ['reject'],  allowed_roles: ['Lead'] },
      { from: 'FIX',     to: 'DEPLOYED', labels: ['mature'],  allowed_roles: ['any'], requires_ac: true },
      { from: 'FIX',     to: 'TRIAGE',   labels: ['iterate'], allowed_roles: ['Lead'] },
      { from: 'FIX',     to: 'ESCALATE', labels: ['timeout'], allowed_roles: ['any'] },
    ],
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('P598 smdlToTemplate transform tests', () => {
  it('AC-11: rfc-5 transforms to 5 states and 7 gates', () => {
    const { states, gates } = smdlToTemplate(RFC5);
    assert.equal(states.length, 5, 'rfc-5 must produce 5 states');
    assert.equal(gates.length, 7, 'rfc-5 must produce 7 gates');
  });

  it('AC-11: rfc-5 states are in order', () => {
    const { states } = smdlToTemplate(RFC5);
    const orders = states.map((s) => s.order);
    assert.deepEqual(orders, [1, 2, 3, 4, 5]);
  });

  it('AC-11: rfc-5 gates with mature label have maturity_required=mature', () => {
    const { gates } = smdlToTemplate(RFC5);
    const matureGates = gates.filter((g) => g.labels.includes('mature'));
    assert.ok(matureGates.length > 0, 'at least one mature gate must exist');
    for (const g of matureGates) {
      assert.equal(g.maturity_required, 'mature', `gate ${g.from}→${g.to} must have maturity_required=mature`);
    }
  });

  it('AC-11: hotfix transforms to 6 states and 6 gates', () => {
    const { states, gates } = smdlToTemplate(HOTFIX);
    assert.equal(states.length, 6, 'hotfix must produce 6 states');
    assert.equal(gates.length, 6, 'hotfix must produce 6 gates');
  });

  it('AC-11: hotfix FIX stage preserves timeout', () => {
    const { states } = smdlToTemplate(HOTFIX);
    const fix = states.find((s) => s.name === 'FIX');
    assert.ok(fix, 'FIX stage must exist');
    assert.equal(fix.timeout, '4h');
  });

  it('AC-11: quick-fix transforms to 5 states and 5 gates', () => {
    const { states, gates } = smdlToTemplate(QUICKFIX);
    assert.equal(states.length, 5, 'quick-fix must produce 5 states');
    assert.equal(gates.length, 5, 'quick-fix must produce 5 gates');
  });

  it('AC-11: smdlIdToTemplateId maps rfc-5 → rfc-5-stage@v1', () => {
    assert.equal(smdlIdToTemplateId('rfc-5', 1), 'rfc-5-stage@v1');
  });

  it('AC-11: smdlIdToTemplateId maps hotfix → hotfix@v1', () => {
    assert.equal(smdlIdToTemplateId('hotfix', 1), 'hotfix@v1');
  });

  it('AC-11: smdlIdToTemplateId maps quick-fix → quick-fix@v1', () => {
    assert.equal(smdlIdToTemplateId('quick-fix', 1), 'quick-fix@v1');
  });

  it('AC-11: transform output is JSON-serializable (no circular refs)', () => {
    const payload = smdlToTemplate(RFC5);
    assert.doesNotThrow(() => JSON.stringify(payload));
  });
});
