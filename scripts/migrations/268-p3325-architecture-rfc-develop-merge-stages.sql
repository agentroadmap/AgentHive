-- Migration 268: P3325 — Add DEVELOP + MERGE stages to Architecture RFC workflow
--
-- Problem: Architecture RFC only had DRAFT→REVIEW→COMPLETE transitions.
-- gate_decision(advance) on a REVIEW-stage architecture proposal jumped straight
-- to COMPLETE, skipping DEVELOP and MERGE. This corrupted the proposal lifecycle
-- for proposals that needed implementation work (e.g. P2335, P901, P1144).
--
-- Fix: Add DEVELOP (order 3) and MERGE (order 4) stages to Architecture RFC.
-- Renumber COMPLETE from order 3 to 5. Add transitions REVIEW→DEVELOP,
-- DEVELOP→MERGE, MERGE→COMPLETE. Keep REVIEW→COMPLETE as an explicit
-- fast-path for pure-architecture decisions that need no implementation.
--
-- The companion code change in pg-handlers.ts fixes ORDER BY in the
-- advance-resolution query to prefer non-terminal intermediate states
-- (DEVELOP, MERGE) over terminal ones (COMPLETE) when multiple forward
-- transitions exist — ensuring sequential lifecycle progression.

BEGIN;

-- Architecture RFC template id is 54 (per migration 205 comments).
-- Renumber COMPLETE from order 3 → 5 to make room for DEVELOP and MERGE.
UPDATE roadmap.workflow_stages
   SET stage_order = 5
 WHERE template_id = 54 AND stage_name = 'COMPLETE';

-- Add DEVELOP (order 3) and MERGE (order 4) stages.
INSERT INTO roadmap.workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
VALUES
  (54, 'DEVELOP', 3, 2, true,  '{"trigger": "approved_for_develop", "role": "developer"}'),
  (54, 'MERGE',   4, 2, false, '{"trigger": "develop_complete",     "role": "PM"}')
ON CONFLICT (template_id, stage_name) DO UPDATE SET
  stage_order    = EXCLUDED.stage_order,
  maturity_gate  = EXCLUDED.maturity_gate,
  requires_ac    = EXCLUDED.requires_ac,
  gating_config  = EXCLUDED.gating_config;

-- Add workflow_transitions for the new edges.
INSERT INTO roadmap.workflow_transitions (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac)
VALUES
  (54, 'REVIEW',  'DEVELOP', '{approve}',         '{PM,Skeptic}',  false),
  (54, 'DEVELOP', 'MERGE',   '{mature,complete}',  '{PM,Architect}', false),
  (54, 'MERGE',   'COMPLETE','{mature,complete}',  '{PM,Architect}', false)
ON CONFLICT (template_id, from_stage, to_stage) DO NOTHING;

-- Mirror into proposal_valid_transitions (the table read by prop_transition
-- validation and by the gate_decision advance-resolution query).
INSERT INTO roadmap_proposal.proposal_valid_transitions
  (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
VALUES
  ('Architecture RFC', 'REVIEW',  'DEVELOP', '{approve}',          '{PM,Skeptic}',  'none'),
  ('Architecture RFC', 'DEVELOP', 'MERGE',   '{mature,complete}',  '{PM,Architect}','none'),
  ('Architecture RFC', 'MERGE',   'COMPLETE','{mature,complete}',  '{PM,Architect}','none')
ON CONFLICT (workflow_name, from_state, to_state) DO NOTHING;

-- Update stage_count on the Architecture RFC template.
UPDATE roadmap.workflow_templates
   SET stage_count = (SELECT COUNT(*) FROM roadmap.workflow_stages WHERE template_id = 54),
       modified_at = NOW()
 WHERE id = 54;

COMMIT;
