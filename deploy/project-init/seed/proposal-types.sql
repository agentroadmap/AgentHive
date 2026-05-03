-- Seed: default workflow templates and proposal types.
-- Run after 002-workflow.sql is applied.
-- Idempotent via ON CONFLICT DO NOTHING.

-- Standard AgentHive feature workflow
INSERT INTO :schema_name.workflow (slug, display_name, description, initial_status)
VALUES
  ('feature',   'Feature',           'New capability or enhancement',         'Draft'),
  ('bugfix',    'Bug Fix',           'Defect correction',                     'Draft'),
  ('refactor',  'Refactor',          'Code quality or architecture change',   'Draft'),
  ('infra',     'Infrastructure',    'Infrastructure, CI/CD, tooling change', 'Draft'),
  ('research',  'Research',          'Investigation or spike',                'Draft'),
  ('hotfix',    'Hotfix',            'Critical production fix — accelerated', 'Develop')
ON CONFLICT (slug) DO NOTHING;

-- Stages for the standard workflow (feature/bugfix/refactor/infra)
WITH w AS (SELECT id FROM :schema_name.workflow WHERE slug = 'feature')
INSERT INTO :schema_name.wStage (workflow_id, name, ordinal, is_terminal, is_gate)
SELECT w.id, stage.name, stage.ord, stage.terminal, stage.gate
FROM w, (VALUES
  ('Draft',    0, false, false),
  ('Review',   1, false, true),
  ('Develop',  2, false, false),
  ('Merge',    3, false, true),
  ('Complete', 4, true,  false),
  ('Recycled', 5, true,  false)
) AS stage(name, ord, terminal, gate)
ON CONFLICT (workflow_id, name) DO NOTHING;

-- Allowed transitions for feature workflow
WITH
  w  AS (SELECT id FROM :schema_name.workflow WHERE slug = 'feature'),
  s  AS (SELECT id, name FROM :schema_name.wStage WHERE workflow_id = (SELECT id FROM w))
INSERT INTO :schema_name.wTransition (workflow_id, from_stage_id, to_stage_id, reason, requires_notes)
SELECT w.id, f.id, t.id, tr.reason, tr.req
FROM w,
  (VALUES
    ('Draft',    'Review',   'mature',    false),
    ('Review',   'Develop',  'decision',  true),
    ('Review',   'Draft',    'iteration', true),
    ('Develop',  'Merge',    'mature',    false),
    ('Develop',  'Review',   'iteration', false),
    ('Merge',    'Complete', 'decision',  true),
    ('Merge',    'Develop',  'iteration', true),
    ('Draft',    'Recycled', 'discard',   true),
    ('Review',   'Recycled', 'discard',   true),
    ('Develop',  'Recycled', 'discard',   true)
  ) AS tr(from_s, to_s, reason, req)
  JOIN s f ON f.name = tr.from_s
  JOIN s t ON t.name = tr.to_s
ON CONFLICT (workflow_id, from_stage_id, to_stage_id, reason) DO NOTHING;

-- Gate checks for Review stage
WITH
  w AS (SELECT id FROM :schema_name.workflow WHERE slug = 'feature'),
  st AS (SELECT id FROM :schema_name.wStage WHERE workflow_id = (SELECT id FROM w) AND name = 'Review')
INSERT INTO :schema_name.wGate (stage_id, check_key, description, is_required, ordinal)
SELECT st.id, g.key, g.label, g.req, g.ord
FROM st, (VALUES
  ('has_summary',    'Proposal has a non-empty summary',          true,  0),
  ('has_motivation', 'Proposal has a non-empty motivation',       true,  1),
  ('has_design',     'Proposal has a design section',             true,  2),
  ('has_ac',         'At least one acceptance criterion defined', true,  3),
  ('has_reviewer',   'At least one review comment present',       false, 4)
) AS g(key, label, req, ord)
ON CONFLICT (stage_id, check_key) DO NOTHING;

-- Gate checks for Merge stage
WITH
  w AS (SELECT id FROM :schema_name.workflow WHERE slug = 'feature'),
  st AS (SELECT id FROM :schema_name.wStage WHERE workflow_id = (SELECT id FROM w) AND name = 'Merge')
INSERT INTO :schema_name.wGate (stage_id, check_key, description, is_required, ordinal)
SELECT st.id, g.key, g.label, g.req, g.ord
FROM st, (VALUES
  ('has_decision',   'A gate decision row exists for this advance',   true,  0),
  ('ac_all_met',     'All acceptance criteria are marked met or skip', true, 1)
) AS g(key, label, req, ord)
ON CONFLICT (stage_id, check_key) DO NOTHING;
