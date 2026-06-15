-- 282-p1366-reap-return-worker-identity.sql
-- P1366 supplement: clear worker_identity when an offer is returned to 'open'.
--
-- Migration 281-p1366-worker-identity-lifecycle.sql set worker_identity at
-- claim time so Cockpit attribution is populated before spawn completes.
-- This migration covers the reverse path: offers that go back to 'open' state
-- (either by reaper or voluntary return) must clear worker_identity so stale
-- identity never carries forward into the next claim cycle.
--
-- Changes:
--   1. fn_reap_expired_offers: SET worker_identity = NULL in the reissue branch.
--      Incorporates the failure_class/failure_is_transient additions from mig 184.
--   2. fn_return_work_offer: SET worker_identity = NULL alongside claim fields.
--
-- Idempotent: CREATE OR REPLACE only.

BEGIN;

-- ── 1. fn_reap_expired_offers ──────────────────────────────────────────────
-- Base: mig 184-p1434-failure-class.sql.
-- P1366 change: added `worker_identity = NULL` in the reissue branch.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_expired_offers()
RETURNS TABLE(reissued_count integer, expired_count integer)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reissued INT := 0;
  v_expired  INT := 0;
  v_row      RECORD;
BEGIN
  FOR v_row IN
    SELECT id, proposal_id, agent_identity, reissue_count, max_reissues
    FROM roadmap_workforce.squad_dispatch
    WHERE offer_status IN ('claimed','active')
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at < now()
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_row.reissue_count < v_row.max_reissues THEN
      -- P1366: clear worker_identity so a reissued (re-opened) offer does not
      -- carry the prior claimant's identity into the next claim cycle.
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status     = 'open',
          dispatch_status  = 'open',
          agent_identity   = NULL,
          worker_identity  = NULL,
          claim_token      = gen_random_uuid(),
          claim_expires_at = NULL,
          claimed_at       = NULL,
          last_renewed_at  = NULL,
          renew_count      = 0,
          reissue_count    = reissue_count + 1,
          offer_version    = offer_version + 1,
          lease_id         = NULL
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at    = now(),
          release_reason = 'lease_expired'
      WHERE proposal_id  = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      v_reissued := v_reissued + 1;

      PERFORM pg_notify('work_offers',
        json_build_object('event','reissued','dispatch_id', v_row.id)::text);
    ELSE
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status        = 'expired',
          dispatch_status     = 'failed',
          completed_at        = now(),
          failure_class       = 'lease_expired',
          failure_is_transient = true,
          metadata            = metadata || jsonb_build_object('failure_reason', 'lease_expired')
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at    = now(),
          release_reason = 'lease_expired'
      WHERE proposal_id  = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      INSERT INTO roadmap.escalation_log (
        obstacle_type, proposal_id, agent_identity, escalated_to, severity
      ) VALUES (
        'AGENT_DEAD', v_row.proposal_id::text, v_row.agent_identity, 'orchestrator', 'high'
      );

      v_expired := v_expired + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_reissued, v_expired;
END;
$function$;

-- ── 2. fn_return_work_offer ────────────────────────────────────────────────
-- Base: mig 153-fix-lifecycle-identity-mismatch.sql.
-- P1366 change: added `worker_identity = NULL` so a voluntarily-returned offer
-- does not carry stale identity into the next claim cycle.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_return_work_offer(
  p_dispatch_id    BIGINT,
  p_agent_identity TEXT,
  p_claim_token    UUID,
  p_reason         TEXT DEFAULT 'unspecified'
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated INT;
BEGIN
  -- P1366: clear worker_identity alongside the other identity/lease fields.
  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status     = 'open',
      dispatch_status  = 'open',
      worker_identity  = NULL,
      claim_token      = gen_random_uuid(),
      claimed_at       = NULL,
      claim_expires_at = NULL,
      last_renewed_at  = NULL,
      metadata         = metadata || jsonb_build_object(
        'return_reason', p_reason,
        'returned_by',   p_agent_identity,
        'returned_at',   to_jsonb(now())
      )
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = 'agent_returned'
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;

    PERFORM pg_notify('work_offers', json_build_object(
      'dispatch_id', p_dispatch_id,
      'event',       'returned',
      'reason',      p_reason
    )::text);
  END IF;

  RETURN v_updated = 1;
END;
$function$;

-- ── 3. Backfill ────────────────────────────────────────────────────────────
-- Catch any rows created between mig 281's backfill and now that still have
-- NULL worker_identity but have a matching liaison_task_tracker record.
-- Restricted to non-terminal offers so closed history rows are not modified.
UPDATE roadmap_workforce.squad_dispatch sd
   SET worker_identity = ltt.worker_identity
  FROM roadmap.liaison_task_tracker ltt
 WHERE sd.id               = ltt.dispatch_id
   AND sd.worker_identity  IS NULL
   AND ltt.worker_identity IS NOT NULL
   AND sd.offer_status NOT IN ('expired', 'delivered', 'failed');

COMMIT;
