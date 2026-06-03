-- proposal-types.sql
-- Seed data: proposal type → workflow binding
-- Run after workflow_load_builtin (or DDL init).
-- Active proposal taxonomy:
--   product       — top-level product definition
--   component     — major subsystem or architectural pillar
--   feature       — specific capability within a component
--   issue         — bug, defect, or problem report (uses Standard RFC)
--   hotfix        — localized operational fix (uses Hotfix workflow)
--   architecture  — architecture decision record (3-stage: DRAFT → REVIEW → COMPLETE)

INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES
  ('product',      'Standard RFC',    'Top-level product definition — vision, pillars, and constraints'),
  ('component',    'Standard RFC',    'Major subsystem or architectural pillar within a product'),
  ('feature',      'Standard RFC',    'A specific capability or behaviour within a component'),
  ('issue',        'Standard RFC',    'Bug, defect, or problem report against a product, component, or feature'),
  ('hotfix',       'Hotfix',          'Localized operational fix to a running instance'),
  -- P609 Step 0: specialist buckets required as FK targets before gate_role seed can reference them
  ('schema',       'Standard RFC',    'Database schema change — DDL migrations, index additions, constraint modifications'),
  ('dr-design',    'Standard RFC',    'Disaster-recovery design — runbook, RTO/RPO targets, failover procedures'),
  ('ai-feature',   'Standard RFC',    'AI/ML feature — prompt engineering, model selection, eval coverage, safety review'),
  -- P1003: architecture decision proposals use a 3-stage workflow (no Develop/Merge)
  ('architecture', 'Architecture RFC', 'Architecture decision proposals — design artifact lifecycle without code delivery stages'),
  -- P188: human-issued commands with elevated dispatch priority (1.5x) and automatic conflict detection
  ('directive',    'Standard RFC',     'Human-issued command with elevated dispatch priority (1.5x) and automatic conflict detection')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description   = EXCLUDED.description;
