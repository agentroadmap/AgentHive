-- 011-maturity-sync-trigger.sql
-- Description: Auto-sync maturity JSONB when proposal status changes
-- Date: 2026-04-08
-- Fixes: maturity column defaults to {"Draft":"New"} and is never updated,
--        leaving stale maturity on every proposal after status transitions.

BEGIN;

-- Map status → maturity level
CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_level text;
BEGIN
  -- Only act on status changes
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Determine maturity level from new status
  v_level := CASE
    WHEN NEW.status IN ('DEPLOYED','COMPLETE','MERGED','CLOSED','WONT_FIX') THEN 'mature'
    WHEN NEW.status IN ('FIX','DEVELOP','REVIEW','REVIEWING','MERGE','ESCALATE') THEN 'active'
    WHEN NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN 'obsolete'
    ELSE 'new'
  END;

  NEW.maturity := jsonb_build_object(NEW.status, v_level);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_maturity_sync ON roadmap.proposal;
CREATE TRIGGER trg_proposal_maturity_sync
  BEFORE UPDATE ON roadmap.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_sync_proposal_maturity();

-- Also fix the column default so new proposals start correctly
ALTER TABLE roadmap.proposal
  ALTER COLUMN maturity DROP DEFAULT;

-- New default will be set by createProposal() initial status logic.
-- For safety, keep a sensible fallback using the status at INSERT time via trigger.
CREATE OR REPLACE FUNCTION roadmap.fn_init_proposal_maturity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.maturity IS NULL THEN
    NEW.maturity := jsonb_build_object(NEW.status, 'new');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_maturity_init ON roadmap.proposal;
CREATE TRIGGER trg_proposal_maturity_init
  BEFORE INSERT ON roadmap.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_init_proposal_maturity();

COMMIT;
