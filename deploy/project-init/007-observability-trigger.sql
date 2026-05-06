-- ============================================================
-- project-init/007-observability-trigger.sql
-- Per-project trigger that populates observability.proposal_lifecycle_event
-- when proposal status or maturity changes.
-- Run with: psql -v schema_name=agentHive -f 007-observability-trigger.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- Trigger function: capture proposal state transitions
-- ============================================================
-- Note: :schema_name is substituted by psql at parse time (outside $$)
-- The function body needs to query core.project at runtime
CREATE OR REPLACE FUNCTION :schema_name.fn_proposal_lifecycle_event()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = :schema_name, core
AS $$
DECLARE
  project_id_val BIGINT;
  schema_name_str TEXT := ':schema_name';
BEGIN
  -- Look up project_id from core.project by schema name
  SELECT id INTO project_id_val
    FROM core.project
   WHERE schema_name = schema_name_str
   LIMIT 1;

  INSERT INTO observability.proposal_lifecycle_event (
    project_id,
    proposal_display_id,
    from_state,
    to_state,
    from_maturity,
    to_maturity,
    triggered_by_did,
    context
  )
  VALUES (
    project_id_val,
    NEW.display_id,
    OLD.status,
    NEW.status,
    OLD.maturity,
    NEW.maturity,
    COALESCE(
      NULLIF(current_setting('app.agent_did', true), ''),
      NULLIF(current_setting('app.agent_identity', true), ''),
      'system'
    ),
    jsonb_build_object('source', 'trg_proposal_lifecycle_event')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_lifecycle_event ON :schema_name.proposal;
CREATE TRIGGER trg_proposal_lifecycle_event
  AFTER UPDATE OF status, maturity ON :schema_name.proposal
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.maturity IS DISTINCT FROM NEW.maturity
  )
  EXECUTE FUNCTION :schema_name.fn_proposal_lifecycle_event();

COMMENT ON TRIGGER trg_proposal_lifecycle_event ON :schema_name.proposal IS
  'Populates observability.proposal_lifecycle_event on proposal state/maturity transitions.';
