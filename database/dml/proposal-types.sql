-- proposal-types.sql
-- Seed data: proposal type → workflow binding
-- Run after workflow_load_builtin (or DDL init).
-- Active proposal taxonomy:
--   product   — top-level product definition
--   component — major subsystem or architectural pillar
--   feature   — specific capability within a component
--   issue     — bug, defect, or problem report (uses Standard RFC)
--   hotfix    — localized operational fix (uses Hotfix workflow)

INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES
  ('product',   'Standard RFC', 'Top-level product definition — vision, pillars, and constraints'),
  ('component', 'Standard RFC', 'Major subsystem or architectural pillar within a product'),
  ('feature',   'Standard RFC', 'A specific capability or behaviour within a component'),
  ('issue',     'Standard RFC', 'Bug, defect, or problem report against a product, component, or feature'),
  ('hotfix',    'Hotfix',       'Localized operational fix to a running instance')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description = EXCLUDED.description;
