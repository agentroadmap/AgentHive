-- P748 Phase 1: Seed enhancer role profile rows
--
-- The orchestrator's drainEnhancementRevisions loop (scripts/orchestrator.ts:2162)
-- queries for enhancer rows but found zero, causing an early-return at line 2174.
-- This migration adds 6 rows: 3 stages (DRAFT, REVIEW, DEVELOP) × 2 workflow
-- template IDs (14, 37). Each row targets 'new' maturity to match held proposals.

BEGIN;

INSERT INTO roadmap.agent_role_profile
  (scope, workflow_template_id, stage, maturity, role, required_capabilities, prompt_template, priority)
VALUES
  ('global', 14, 'DRAFT',   'new', 'enhancer', ARRAY['proposal_management','design'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100),
  ('global', 14, 'REVIEW',  'new', 'enhancer', ARRAY['proposal_management','design'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100),
  ('global', 14, 'DEVELOP', 'new', 'enhancer', ARRAY['proposal_management','code_generation'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100),
  ('global', 37, 'DRAFT',   'new', 'enhancer', ARRAY['proposal_management','design'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100),
  ('global', 37, 'REVIEW',  'new', 'enhancer', ARRAY['proposal_management','design'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100),
  ('global', 37, 'DEVELOP', 'new', 'enhancer', ARRAY['proposal_management','code_generation'],
   '{"task_prompt": "You are the Enhancer for proposal {display_id} (P{proposal_id}) currently in {status}/new.\nA gate reviewer placed it on hold. Read the full gate rationale and AC verification results below.\nClose every cited gap: update design, acceptance criteria, and implementation as needed.\nWhen ALL gaps are resolved, call: mcp_proposal action=set_maturity proposal_id={proposal_id} maturity=mature"}'::jsonb,
   100)
ON CONFLICT DO NOTHING;

COMMIT;
