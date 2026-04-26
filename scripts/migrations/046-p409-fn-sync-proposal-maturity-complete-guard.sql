-- 046-p409-fn-sync-proposal-maturity-complete-guard.sql
-- Description: Fix P409 — prevent fn_sync_proposal_maturity from downgrading COMPLETE proposals
-- Bug: fn_sync_proposal_maturity unconditionally recomputes maturity even when a proposal
--      has already been advanced to a terminal stage (COMPLETE, DEPLOYED, CLOSED, MERGED)
--      and marked maturity='mature'. This causes data corruption.
-- Fix: Add terminal-stage guard: if proposal.status is in a terminal stage set, skip
--      maturity recomputation entirely. Terminal stages are determined dynamically from
--      the workflow config. For now, we hardcode the known terminals and return early.
-- P-ref: P409
-- Date: 2026-04-25

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_level text;
BEGIN
  -- Only act on status changes
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- GUARD: Terminal-stage proposals must not have maturity recomputed.
  -- Terminal stages are: COMPLETE, DEPLOYED, CLOSED, MERGED, RECYCLED.
  -- Once a proposal reaches these states and maturity is set to 'mature',
  -- further updates should not touch maturity.
  IF NEW.status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN
    RETURN NEW;
  END IF;

  -- Determine maturity level from new status
  v_level := CASE
    WHEN NEW.status IN ('FIX','DEVELOP','REVIEW','REVIEWING','MERGE','ESCALATE') THEN 'active'
    WHEN NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN 'obsolete'
    ELSE 'new'
  END;

  NEW.maturity := jsonb_build_object(NEW.status, v_level);
  RETURN NEW;
END;
$$;

COMMIT;
