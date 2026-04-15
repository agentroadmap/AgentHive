-- Migration 023: Fix gate_decision_log schema for P167/P168
-- Problem: roadmap_proposal.gate_decision_log is missing columns needed by
-- orchestrator-with-skeptic.ts (ac_verification, dependency_check, challenges,
-- blockers). The roadmap.gate_decision_log VIEW is also missing these columns.
-- The CHECK constraint uses 'advance' not 'approve', and the decided_by FK
-- requires a registered agent identity.

BEGIN;

-- Set default for maturity (NOT NULL column, but orchestrator doesn't know proposal maturity)
ALTER TABLE roadmap_proposal.gate_decision_log
  ALTER COLUMN maturity SET DEFAULT 'mature';

-- Add missing structured columns to base table
ALTER TABLE roadmap_proposal.gate_decision_log
  ADD COLUMN IF NOT EXISTS gate_level      text        NULL,
  ADD COLUMN IF NOT EXISTS ac_verification jsonb       NULL,
  ADD COLUMN IF NOT EXISTS dependency_check jsonb      NULL,
  ADD COLUMN IF NOT EXISTS design_review   jsonb       NULL,
  ADD COLUMN IF NOT EXISTS challenges      text[]      NULL,
  ADD COLUMN IF NOT EXISTS blockers        text[]      NULL;

COMMENT ON COLUMN roadmap_proposal.gate_decision_log.gate_level    IS 'D1=DRAFT→REVIEW, D2=REVIEW→DEVELOP, D3=DEVELOP→MERGE, D4=MERGE→COMPLETE';
COMMENT ON COLUMN roadmap_proposal.gate_decision_log.ac_verification IS 'AC check summary: {passed: #, failed: #, blocked: #}';
COMMENT ON COLUMN roadmap_proposal.gate_decision_log.dependency_check IS 'Dependency validation: {resolved: bool, blockers: []}';
COMMENT ON COLUMN roadmap_proposal.gate_decision_log.challenges     IS 'Open questions raised during gate review';
COMMENT ON COLUMN roadmap_proposal.gate_decision_log.blockers       IS 'Blocking issues preventing advancement';

-- Register 'gate-agent' as the canonical gate reviewer identity (idempotent)
-- 'skeptic' is an alias — map to gate-agent in the orchestrator instead
-- (gate-agent already exists in agent_registry)

-- Update roadmap.gate_decision_log view to expose new columns
-- Must DROP first — CREATE OR REPLACE cannot reorder or add columns before existing ones
DROP VIEW IF EXISTS roadmap.gate_decision_log;
CREATE VIEW roadmap.gate_decision_log AS
  SELECT id,
         proposal_id,
         from_state,
         to_state,
         maturity,
         gate,
         gate_level,
         decided_by,
         authority_agent,
         decision,
         rationale,
         ac_verification,
         dependency_check,
         design_review,
         challenges,
         blockers,
         signature_hash,
         created_at
    FROM roadmap_proposal.gate_decision_log;

-- Grant read on the updated view to all agent roles
GRANT SELECT ON roadmap.gate_decision_log TO agent_read;
GRANT SELECT ON roadmap.gate_decision_log TO agent_write;

COMMIT;
