-- P1124: D4 Merge-Gate E2E Validator — dispatch-wired AC verification job
-- Branch C (Merge): Automated AC verification at MERGE stage gate
--
-- PURPOSE:
--   The MERGE stage advances proposals to COMPLETE after gating. Currently, this advancement
--   is manual (a gate reviewer submits a gate_decision log row). This migration seeds the
--   mechanism for an automated "D4 Merge-Gate E2E Validator" dispatch job that:
--   1. Runs at the proposal's MERGE/mature state
--   2. Programmatically executes all proposal AC checks (proposal_acceptance_criteria rows)
--   3. Records results in proposal_acceptance_criteria.status + .details
--   4. Writes a gate_decision_log entry that triggers MERGE -> COMPLETE advance
--   5. Blocks advance if any AC fails
--
-- DESIGN RATIONALE:
--   - P1094 (D4 role binding) established that MERGE gate uses 'gate-reviewer' role
--   - P1140 (Deliverable Verification) validates that code artifacts exist
--   - P1112 (Response Verification) validates that proposal responses meet criteria
--   - P1124 (this) validates that ACCEPTANCE CRITERIA themselves pass (the final gate)
--   - Boundary: P1124 is MERGE-stage specific; it verifies the AC that define Done
--   - Dispatch wiring: integrates with orchestrator scanQueues() at MERGE/mature
--
-- IMPLEMENTATION OUTLINE (AC breakdown):
--   AC-1: Dispatch job definition (queue context + role profile)
--   AC-2: Job entrypoint (scripts/d4-e2e-validate-merge.ts + test)
--   AC-3: AC runner loop (executes each proposal_acceptance_criteria by category)
--   AC-4: Results capture (writes AC status + evidence to proposal_acceptance_criteria.details)
--   AC-5: Gate integration (emits gate_decision_log row + MERGE -> COMPLETE trigger)
--   AC-6: Failure handling (blocks advance if any AC not 'pass' or 'waived')
--   AC-7: Live-DB test suite (env-gated, proves job wires + advances correctly)
--   AC-8: Documentation (architecture doc linking P1094 + P1112 + P1140 + P1124)
--
-- TABLES TOUCHED:
--   roadmap.agent_role_profile — add MERGE/mature 'd4-e2e-validator' role
--   roadmap_proposal.gate_stage_role — future role configuration (reserved, not yet populated)
--   roadmap_proposal.proposal_acceptance_criteria — already has .details + .details_schema_version (P707)

BEGIN;

-- Seed the D4 E2E Validator role profile for Standard RFC at MERGE/mature.
-- This role is scheduled AFTER gate-reviewer; it checks if ALL ACs are pass/waived before MERGE -> COMPLETE.
INSERT INTO roadmap.agent_role_profile
  (scope, workflow_template_id, stage, maturity, role, required_capabilities, prompt_template, priority)
VALUES
  (
    'global',
    14, -- Standard RFC workflow (CONVENTIONS §5 defines workflow 14)
    'MERGE',
    'mature',
    'd4-e2e-validator',
    ARRAY['gating', 'qa', 'e2e-testing', 'ac-verification', 'merge-readiness'],
    '{"system": "You are the D4 E2E merge validator. Run all proposal acceptance criteria checks. For each AC, execute the verification logic (code test, artifact check, or review validation). Mark AC status to pass/fail/waived based on results. Emit gate_decision and MERGE->COMPLETE only if all non-waived ACs pass.", "mode": "d4_merge_validator", "category": "gate", "gate": "D4", "dispatch_timeout_ms": 600000}'::jsonb,
    10 -- Lower priority than gate-reviewer (5), runs second-pass if gate approves
  )
ON CONFLICT (workflow_template_id, stage, maturity, role)
  WHERE scope = 'global' AND project_id IS NULL
DO UPDATE SET
  required_capabilities = EXCLUDED.required_capabilities,
  prompt_template = EXCLUDED.prompt_template,
  priority = EXCLUDED.priority,
  updated_at = now();

-- Ensure the registry has at least a placeholder for the d4-e2e-validator role.
-- In production, this will be a real gating agent (likely the same 'Gate Reviewer' agent with extended skills).
INSERT INTO roadmap_workforce.agent_registry
  (agent_identity, agent_type, role, skills, status, trust_tier)
SELECT
  'd4-e2e-validator',
  'llm',
  'd4-e2e-validator',
  '["gating","qa","e2e-testing","ac-verification","merge-readiness"]'::jsonb,
  'active',
  'trusted'
WHERE NOT EXISTS (
  SELECT 1
    FROM roadmap_workforce.agent_registry
   WHERE status = 'active'
     AND role = 'd4-e2e-validator'
);

-- Optional: Create a notes discussion on P1124 linking the design to this migration
-- (This is informational; the DB doesn't enforce it as part of AC verification)
-- Operator will mark this as mature once code is ready.

COMMIT;
