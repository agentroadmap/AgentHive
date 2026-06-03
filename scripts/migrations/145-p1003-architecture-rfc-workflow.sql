-- P1003: Restore Architecture RFC workflow registry
-- Fixes:
--   1. Architecture RFC template stages to uppercase (DRAFT/REVIEW/COMPLETE)
--      The template was initially loaded via MCP with mixed-case stage names.
--   2. Binds proposal_type_config: architecture → Architecture RFC
--   3. Backfills roadmap.workflows for DRAFT/REVIEW/COMPLETE architecture proposals
--      Skips DEVELOP/MERGE — those require manual triage (noted in proposal discussion)
--   4. Seeds agent_role_profile for Architecture RFC stages

BEGIN;

-- ─── 0. Capture template ID ───────────────────────────────────────────────────
-- Architecture RFC was loaded by MCP workflow_load before this migration runs.
-- This migration is idempotent via ON CONFLICT clauses throughout.

DO $$
DECLARE v_tid BIGINT;
BEGIN
  SELECT id INTO v_tid FROM roadmap.workflow_templates WHERE name = 'Architecture RFC';
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'Architecture RFC workflow template not found — run workflow_load first';
  END IF;
END $$;

-- ─── 1. Fix Architecture RFC stages to uppercase ──────────────────────────────
-- Remove mixed-case rows that were created by the initial MCP workflow_load.
DELETE FROM roadmap.workflow_stages
WHERE template_id = (SELECT id FROM roadmap.workflow_templates WHERE name = 'Architecture RFC')
  AND stage_name IN ('Draft', 'Review', 'Complete');

-- Insert correct uppercase stages
INSERT INTO roadmap.workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
SELECT t.id, s.stage_name, s.stage_order, s.maturity_gate, s.requires_ac, NULL
FROM roadmap.workflow_templates t
CROSS JOIN (VALUES
  ('DRAFT',    1, 2, false),
  ('REVIEW',   2, 2, true),
  ('COMPLETE', 3, 0, false)
) AS s(stage_name, stage_order, maturity_gate, requires_ac)
WHERE t.name = 'Architecture RFC'
ON CONFLICT (template_id, stage_name) DO UPDATE SET
  stage_order   = EXCLUDED.stage_order,
  maturity_gate = EXCLUDED.maturity_gate,
  requires_ac   = EXCLUDED.requires_ac;

-- ─── 2. Fix Architecture RFC transitions to uppercase ─────────────────────────
DELETE FROM roadmap.workflow_transitions
WHERE template_id = (SELECT id FROM roadmap.workflow_templates WHERE name = 'Architecture RFC')
  AND (from_stage IN ('Draft', 'Review') OR to_stage IN ('Review', 'Complete', 'Draft'));

INSERT INTO roadmap.workflow_transitions
  (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac, gating_rules)
SELECT t.id, tr.from_stage, tr.to_stage, tr.labels, tr.allowed_roles, tr.requires_ac, NULL
FROM roadmap.workflow_templates t
CROSS JOIN (VALUES
  ('DRAFT',  'REVIEW',   ARRAY['mature'],            ARRAY['enhancer','reviewer','architect'], false),
  ('REVIEW', 'COMPLETE', ARRAY['advance','accept'],   ARRAY['reviewer','architect'],           true),
  ('REVIEW', 'DRAFT',    ARRAY['return','iteration'], ARRAY['reviewer','architect'],           false)
) AS tr(from_stage, to_stage, labels, allowed_roles, requires_ac)
WHERE t.name = 'Architecture RFC'
ON CONFLICT (template_id, from_stage, to_stage) DO UPDATE SET
  labels        = EXCLUDED.labels,
  allowed_roles = EXCLUDED.allowed_roles,
  requires_ac   = EXCLUDED.requires_ac;

-- ─── 3. Mirror transitions into proposal_valid_transitions ────────────────────
-- proposal_valid_transitions is the table read by transitionProposal() validation.
-- requires_ac bool → 'all'|'none' text enum (matches smdl-loader convention).
DELETE FROM roadmap_proposal.proposal_valid_transitions
WHERE workflow_name = 'Architecture RFC';

INSERT INTO roadmap_proposal.proposal_valid_transitions
  (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
VALUES
  ('Architecture RFC', 'DRAFT',  'REVIEW',   ARRAY['mature'],            ARRAY['enhancer','reviewer','architect'], 'none'),
  ('Architecture RFC', 'REVIEW', 'COMPLETE', ARRAY['advance','accept'],   ARRAY['reviewer','architect'],           'all'),
  ('Architecture RFC', 'REVIEW', 'DRAFT',    ARRAY['return','iteration'], ARRAY['reviewer','architect'],           'none')
ON CONFLICT (workflow_name, from_state, to_state) DO UPDATE SET
  allowed_reasons = EXCLUDED.allowed_reasons,
  allowed_roles   = EXCLUDED.allowed_roles,
  requires_ac     = EXCLUDED.requires_ac;

-- ─── 4. Bind architecture type → Architecture RFC ─────────────────────────────
INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES ('architecture', 'Architecture RFC',
        'Architecture decision proposals — design artifact lifecycle without code delivery stages')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description   = EXCLUDED.description;

-- ─── 5. Backfill roadmap.workflows for safe architecture proposals ─────────────
-- Only DRAFT, REVIEW, and COMPLETE proposals: those stages exist in Architecture RFC.
-- DEVELOP and MERGE proposals are skipped — they have no matching stage in Architecture RFC
-- and must be triaged manually (see P1003 discussion for the affected proposal list).
UPDATE roadmap.workflows w
SET template_id = (SELECT id FROM roadmap.workflow_templates WHERE name = 'Architecture RFC')
WHERE w.proposal_id IN (
  SELECT p.id
  FROM roadmap_proposal.proposal p
  WHERE p.type = 'architecture'
    AND p.status IN ('DRAFT', 'REVIEW', 'COMPLETE')
)
AND w.template_id = (SELECT id FROM roadmap.workflow_templates WHERE name = 'Standard RFC');

-- ─── 6. Seed agent_role_profile for Architecture RFC ─────────────────────────
-- Architecture proposals have no build stages (no DEVELOP/MERGE).
-- DRAFT: researchers and architects shape the decision
-- REVIEW: reviewers and architects gate the decision
INSERT INTO roadmap.agent_role_profile
  (scope, workflow_template_id, stage, maturity, role, priority)
SELECT 'global', t.id, s.stage, s.maturity, s.role, s.priority
FROM roadmap.workflow_templates t
CROSS JOIN (VALUES
  ('DRAFT',  'new',    'researcher', 10),
  ('DRAFT',  'new',    'architect',  20),
  ('DRAFT',  'active', 'researcher', 10),
  ('DRAFT',  'active', 'architect',  20),
  ('DRAFT',  'mature', 'reviewer',   10),
  ('DRAFT',  'mature', 'architect',  20),
  ('REVIEW', 'new',    'architect',  10),
  ('REVIEW', 'new',    'skeptic',    20),
  ('REVIEW', 'active', 'architect',  10),
  ('REVIEW', 'active', 'skeptic',    20),
  ('REVIEW', 'mature', 'skeptic-alpha', 10),
  ('REVIEW', 'mature', 'architect',     20)
) AS s(stage, maturity, role, priority)
WHERE t.name = 'Architecture RFC'
ON CONFLICT DO NOTHING;

-- ─── 7. Update stage_count on the template ────────────────────────────────────
UPDATE roadmap.workflow_templates
SET stage_count = (
  SELECT COUNT(*) FROM roadmap.workflow_stages
  WHERE template_id = (SELECT id FROM roadmap.workflow_templates WHERE name = 'Architecture RFC')
),
modified_at = NOW()
WHERE name = 'Architecture RFC';

COMMIT;
