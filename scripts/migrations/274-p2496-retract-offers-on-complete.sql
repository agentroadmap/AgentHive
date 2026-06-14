-- 274-p2496-retract-offers-on-complete.sql
-- P2496 AC-2: Offer retraction on COMPLETE transition.
--
-- COMPLETE is a terminal proposal state. The offer-generation guards (AC-1/4/5/6)
-- stop NEW offers being posted for COMPLETE proposals, but any offers that were
-- already open/claimed at the moment a proposal is completed must be retracted —
-- otherwise they sit in roadmap_workforce.squad_dispatch as live work, outrank
-- genuine DEVELOP/new offers in claim priority, and starve real work (the
-- "dispatch churn on COMPLETE proposals" pathology, 2026-06-09).
--
-- This AFTER-UPDATE trigger expires those stragglers atomically with the status
-- transition, so the invariant
--   SELECT count(*) FROM roadmap_workforce.squad_dispatch s
--     JOIN roadmap_proposal.proposal p ON p.id = s.proposal_id
--    WHERE s.offer_status IN ('open','claimed') AND p.status='COMPLETE'
-- is always 0 going forward (AC-3).
--
-- Schema verified live (2026-06-14):
--   roadmap_workforce.squad_dispatch(proposal_id bigint, offer_status text,
--     completed_at timestamptz). CHECK squad_dispatch_offer_status_check allows
--     'expired'. roadmap_proposal.proposal(id bigint, status text); a BEFORE
--     trigger (trg_normalize_proposal_status) upper-cases status, so live values
--     are 'COMPLETE'. UPPER() below is belt-and-suspenders against trigger order.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS / CREATE TRIGGER.
-- Safe to re-run. No inner BEGIN/COMMIT — the migration runner wraps this file
-- in a transaction.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_retract_offers_on_proposal_complete()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
BEGIN
  -- Expire every still-live offer for the just-completed proposal. Scoped to
  -- offer_status IN ('open','claimed') AND completed_at IS NULL so we never
  -- touch already-terminal rows (delivered/expired/failed) and the write is a
  -- no-op when there is nothing to retract.
  UPDATE roadmap_workforce.squad_dispatch
     SET offer_status = 'expired',
         completed_at = now()
   WHERE proposal_id = NEW.id
     AND offer_status IN ('open', 'claimed')
     AND completed_at IS NULL;

  RETURN NULL; -- AFTER trigger: return value ignored
END;
$function$;

DROP TRIGGER IF EXISTS trg_retract_offers_on_complete ON roadmap_proposal.proposal;

CREATE TRIGGER trg_retract_offers_on_complete
  AFTER UPDATE OF status ON roadmap_proposal.proposal
  FOR EACH ROW
  WHEN (
    UPPER(NEW.status) = 'COMPLETE'
    AND UPPER(COALESCE(OLD.status, '')) <> 'COMPLETE'
  )
  EXECUTE FUNCTION roadmap_workforce.fn_retract_offers_on_proposal_complete();
