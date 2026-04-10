-- ============================================================
-- Migration 004: Multi-Template Workflow Support
-- Purpose: Allow flexible, user-configurable workflows
--   - Drop hardcoded CHECK constraints on state names
--   - Validate via proposal_valid_transitions data (data-driven)
--   - workflow_name column tags transitions to specific templates
--   - v_known_states view shows valid states per workflow
-- ============================================================
BEGIN;

-- 1. Drop hardcoded CHECK constraints (they limited us to 9 specific states)
ALTER TABLE proposal_state_transitions DROP CONSTRAINT IF EXISTS proposal_state_transitions_from_state_check;
ALTER TABLE proposal_state_transitions DROP CONSTRAINT IF EXISTS proposal_state_transitions_to_state_check;

-- 2. Create helper view for known states per workflow
CREATE OR REPLACE VIEW v_known_states AS
SELECT DISTINCT workflow_name, from_state AS state FROM proposal_valid_transitions
UNION
SELECT DISTINCT workflow_name, to_state AS state FROM proposal_valid_transitions;

-- 3. Future multi-template tables (not yet deployed):
-- CREATE TABLE workflow_templates (
--     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     name text NOT NULL UNIQUE,
--     description text,
--     is_default boolean DEFAULT false,
--     stage_count int,
--     created_at timestamptz DEFAULT now()
-- );

COMMIT;

-- Usage:
-- To add a 6-stage workflow: insert into proposal_valid_transitions with new workflow_name
-- To validate a transition: check proposal_valid_transitions (already done by handlers)
-- To list available states: SELECT * FROM v_known_states WHERE workflow_name = 'MyWorkflow';
