-- Migration 172 — Preserve lease actor on lease-driven maturity transitions
--
-- Lease claims are the only path that should move maturity to active, but the
-- proposal update used to run without app.agent_identity. The maturity audit
-- trigger therefore recorded transitioned_by='system' for agent lease claims.
--
-- Keep the trigger local to roadmap_proposal, but set the local transaction
-- actor from the inserted lease row before updating the proposal so
-- roadmap.fn_notify_maturity_change() records the actual lease holder.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_lease_set_maturity_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.released_at IS NULL THEN
    PERFORM set_config('app.agent_identity', NEW.agent_identity, true);

    UPDATE roadmap_proposal.proposal
       SET maturity = 'active'
     WHERE id = NEW.proposal_id
       AND maturity <> 'obsolete';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_lease_set_maturity_active()
IS 'Sets proposal maturity active on live lease insert and propagates the lease holder into app.agent_identity for maturity audit rows.';

COMMIT;
