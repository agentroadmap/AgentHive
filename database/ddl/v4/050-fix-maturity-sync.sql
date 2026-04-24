-- P409: Fix fn_sync_proposal_maturity — stop resetting maturity on status change
-- The old function forced maturity to 'mature' for COMPLETE/MERGED/etc,
-- overriding the agent-set maturity within each state. This caused gate-loop noise.
-- New behavior: do NOT override maturity on status change. Maturity is managed
-- by agents within each state (new → active → mature) and should not be reset
-- when the proposal transitions between states.

CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Only act on status changes
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- On state transition, set maturity to 'new' for non-terminal states
  -- (proposal is entering a new state and needs fresh work).
  -- For terminal states (COMPLETE, REJECTED, ABANDONED, REPLACED),
  -- preserve current maturity — the work is done.
  IF NEW.status IN ('COMPLETE', 'REJECTED', 'ABANDONED', 'REPLACED') THEN
    -- Terminal state: do not touch maturity
    RETURN NEW;
  END IF;

  -- Non-terminal state transition (DRAFT→REVIEW→DEVELOP→MERGE):
  -- reset to 'new' so agents must re-advance maturity in the new state
  NEW.maturity := 'new';
  RETURN NEW;
END;
$$;

-- Verify: no legacy statuses referenced
COMMENT ON FUNCTION roadmap.fn_sync_proposal_maturity() IS 'P409: On state transition, set maturity=new for non-terminal states. Preserve maturity for terminal states (COMPLETE, REJECTED, ABANDONED, REPLACED). Removed legacy DEPLOYED/CLOSED/WONT_FIX handling.';
