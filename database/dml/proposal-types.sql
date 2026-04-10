-- proposal-types.sql
-- Seed data: proposal type → workflow binding
-- Run once after workflow_load_builtin (or DDL init).
-- These four types define the universal product taxonomy:
--   product   — top-level product definition
--   component — major subsystem or architectural pillar
--   feature   — specific capability within a component
--   issue     — bug, defect, or problem report

INSERT INTO roadmap.proposal_type_config (type, workflow_name, description)
SELECT v.type, v.workflow_name, v.description
FROM (VALUES
  ('product',   'Standard RFC', 'Top-level product definition — vision, pillars, and constraints'),
  ('component', 'Standard RFC', 'Major subsystem or architectural pillar within a product'),
  ('feature',   'Standard RFC', 'A specific capability or behaviour within a component'),
  ('issue',     'Quick Fix',    'Bug, defect, or problem report against a product, component, or feature')
) AS v(type, workflow_name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roadmap.proposal_type_config WHERE type = v.type
);
