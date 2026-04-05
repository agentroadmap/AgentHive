-- ============================================================
-- Migration 004: Multi-Template Workflow Support
-- Date: 2026-04-04
-- Requirement: GQ77 — allow flexible workflows (6+ stages, 
--   different gating, user-selectable templates)
-- ============================================================

BEGIN;

-- 1. Tag valid transitions by workflow name (supports multiple templates)
ALTER TABLE proposal_valid_transitions 
  ADD COLUMN IF NOT EXISTS workflow_name text DEFAULT 'RFC 5-Stage';

UPDATE proposal_valid_transitions 
  SET workflow_name = 'RFC 5-Stage' 
  WHERE workflow_name IS NULL;

-- 2. Drop hardcoded CHECK constraint on rfc_state
--    States are now validated against proposal_valid_transitions data
ALTER TABLE proposal DROP CONSTRAINT IF EXISTS proposal_rfc_state_check;

-- 3. Add workflow_name to proposals (links proposal to a template)
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS workflow_name text DEFAULT 'RFC 5-Stage';
UPDATE proposal SET workflow_name = 'RFC 5-Stage' WHERE workflow_name IS NULL;
CREATE INDEX IF NOT EXISTS idx_proposal_workflow ON proposal(workflow_name);

COMMIT;

-- ============================================================
-- FUTURE: When building template selection UI
-- ============================================================
-- CREATE TABLE workflow_templates (
--     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     name text NOT NULL UNIQUE,
--     description text,
--     is_default boolean DEFAULT false,
--     created_at timestamptz DEFAULT now()
-- );
-- 
-- INSERT INTO workflow_templates (name, description, is_default)
-- VALUES ('RFC 5-Stage', 'Standard RFC workflow', true),
--        ('Lightweight Review', 'Quick review without AC gating', false);
--
-- Then: INSERT new transition sets into proposal_valid_transitions
-- with different workflow_name values to define new workflows
