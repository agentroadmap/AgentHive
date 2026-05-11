-- ============================================================
-- agentHive2 — 007-observability-trigger.sql
-- Per-project proposal lifecycle trigger
-- Installed into each tenant project schema. Captures proposal
-- status and maturity changes into observability.proposal_lifecycle_event.
-- Executed by deploy/apply.sh with --project-only and -v schema_name=<schema>.
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- fn_proposal_lifecycle_event — trigger function
-- Fires on UPDATE of status or maturity on the proposal table.
-- Writes an event to observability.proposal_lifecycle_event if
-- the observability schema exists in this DB.
--
-- Note: This function is created in the global namespace (not per-schema)
-- so it can be referenced from any project schema.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_proposal_lifecycle_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_project_id BIGINT;
BEGIN
    -- No-op if observability schema not present in this DB
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'observability'
    ) THEN
        RETURN NEW;
    END IF;

    -- Try to resolve project_id from core.project if available
    -- (It should always exist in agentHive2, but be defensive)
    BEGIN
        SELECT id INTO v_project_id FROM core.project LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v_project_id := NULL;
    END;

    -- Insert the lifecycle event into observability
    INSERT INTO observability.proposal_lifecycle_event
        (proposal_id, project_id, from_status, to_status, from_maturity, to_maturity, changed_by)
    VALUES (
        NEW.id::TEXT,
        v_project_id,
        OLD.status,
        NEW.status,
        OLD.maturity,
        NEW.maturity,
        current_user
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_proposal_lifecycle_event() IS
  'Trigger function for proposal lifecycle events. Captures status and maturity '
  'transitions into observability.proposal_lifecycle_event. '
  'Designed to work in per-project schemas where observability may or may not exist.';

-- ============================================================
-- Create trigger on :schema_name.proposal table
-- Applied conditionally to handle missing table gracefully.
-- The :schema_name variable is substituted by psql before execution.
-- ============================================================

-- Drop existing trigger if present
DROP TRIGGER IF EXISTS trig_proposal_lifecycle_event ON :schema_name.proposal;

-- Create new trigger (outside the $$ delimiters so :schema_name is substituted)
CREATE TRIGGER trig_proposal_lifecycle_event
  AFTER UPDATE OF status, maturity ON :schema_name.proposal
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.maturity IS DISTINCT FROM NEW.maturity)
  EXECUTE FUNCTION fn_proposal_lifecycle_event();

COMMENT ON TRIGGER trig_proposal_lifecycle_event ON :schema_name.proposal IS
  'Captures proposal status and maturity transitions into observability.proposal_lifecycle_event.';
