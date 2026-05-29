-- 184-p1434-failure-class.sql
-- V3-C2 (P1434): cause-aware dispatch circuit breaker — failure classification.
--
-- PROBLEM: the dispatch-loop breaker (post-work-offer.ts) counts failures
-- regardless of CAUSE. It sums (a) agent_runs failures and (b) squad_dispatch
-- failures over the last hour, and pauses the proposal past a threshold.
-- Provider outages (401 auth, 429 rate-limit, quota), capacity exhaustion
-- (no eligible agency, lease expiry), and spawn timeouts all count identically
-- to a genuine post-delivery retry loop. This produced the constant
-- "Dispatch loop detected for proposal N (role)" CRITICAL spam and forced
-- repeated manual backdate+unpause during the 2026-05-27..29 incident arc
-- (P238, P304, P194, P1114 all falsely paused by auth-401 residue).
--
-- This migration adds the classification columns + backfill. The stamping at
-- each failure site and the breaker query change ship in the same C2 set
-- (offer-dispatch-handler.ts, fn_reap_expired_offers, post-work-offer.ts).
--
-- failure_class taxonomy:
--   auth_rejected     — 401/403; provider credentials dead (transient: route elsewhere)
--   rate_limited      — 429; provider throttled (transient)
--   quota_exhausted   — subscription/budget cap hit (transient)
--   no_eligible_agency— offer expired with no capable/available claimer (transient)
--   lease_expired     — reaper exhausted reissues without a completing worker (transient)
--   unknown           — a genuine failure not attributable to the above; the ONLY
--                       class the loop breaker counts. Non-transient.
--
-- Absorbs P1390 (distinguish capacity-saturation from dispatch-loop).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint.

BEGIN;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS failure_is_transient boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'squad_dispatch_failure_class_check'
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT squad_dispatch_failure_class_check
      CHECK (failure_class IS NULL OR failure_class IN (
        'auth_rejected', 'rate_limited', 'quota_exhausted',
        'no_eligible_agency', 'lease_expired', 'unknown'
      )) NOT VALID;  -- NOT VALID: don't rescan historical rows; new writes are checked
  END IF;
END$$;

-- Partial index for the breaker's hot path (count unknown non-transient failures
-- per proposal+role in the last hour).
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_real_loop
  ON roadmap_workforce.squad_dispatch (proposal_id, dispatch_role, completed_at)
  WHERE dispatch_status = 'failed'
    AND failure_class = 'unknown'
    AND failure_is_transient = false;

-- Backfill existing failed rows from the metadata.failure_reason marker that
-- P1393 (rate_limited) and migration 181/P1406 (lease_expired) already stamp.
-- Everything else that failed becomes 'unknown' (the breaker's countable class);
-- forward-stamping at the failure sites is what fixes live behavior going forward.
UPDATE roadmap_workforce.squad_dispatch
   SET failure_class = CASE
         WHEN metadata->>'failure_reason' = 'rate_limited'  THEN 'rate_limited'
         WHEN metadata->>'failure_reason' = 'lease_expired' THEN 'lease_expired'
         ELSE 'unknown'
       END,
       failure_is_transient = COALESCE(metadata->>'failure_reason' IN ('rate_limited', 'lease_expired'), false)
 WHERE dispatch_status = 'failed'
   AND failure_class IS NULL
   -- Skip ancient schema-drift rows (object-form required_capabilities) that
   -- would fail the NOT VALID sd_required_capabilities_nonempty check on UPDATE.
   -- They stay failure_class=NULL (excluded from the breaker's 'unknown' count),
   -- which is harmless — same precedent as the P1406 reaper backfill.
   AND jsonb_typeof(required_capabilities) = 'array';

-- ── Stamp failure_class at the failure sites (AC-2) ──────────────────────────

-- fn_complete_work_offer: on a 'failed' completion, default failure_class to
-- 'unknown' (the ONLY class the breaker counts) UNLESS the caller already
-- pre-stamped a transient class (auth_rejected/rate_limited/quota_exhausted) on
-- the row. COALESCE preserves the pre-stamp. failure_is_transient is NOT NULL
-- default false and is set by the pre-stamping caller when applicable.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_complete_work_offer(
  p_dispatch_id bigint, p_agent_identity text, p_claim_token uuid,
  p_status text DEFAULT 'delivered'::text
)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated INT;
  v_dispatch_status TEXT;
BEGIN
  IF p_status NOT IN ('delivered','failed') THEN
    RAISE EXCEPTION 'invalid completion status %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_dispatch_status := CASE p_status
    WHEN 'delivered' THEN 'completed'
    WHEN 'failed'    THEN 'failed'
  END;

  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status    = p_status,
      dispatch_status = v_dispatch_status,
      completed_at    = now(),
      agency_identity = COALESCE(agency_identity, p_agent_identity),
      -- V3-C2: classify the failure. Default 'unknown' (countable) but preserve
      -- a transient class the caller pre-stamped before completing.
      failure_class   = CASE WHEN p_status = 'failed'
                             THEN COALESCE(failure_class, 'unknown')
                             ELSE failure_class END
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = CASE p_status
          WHEN 'delivered' THEN 'work_delivered'
          ELSE 'work_failed'
        END
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;
  END IF;

  RETURN v_updated = 1;
END;
$function$;

-- fn_reap_expired_offers: on the exhaustion branch (reissues spent), stamp
-- failure_class='lease_expired' + transient alongside the existing metadata
-- marker, so the breaker never counts a reaped offer as a real loop.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_expired_offers()
RETURNS TABLE(reissued_count integer, expired_count integer)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reissued INT := 0;
  v_expired INT := 0;
  v_row RECORD;
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
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status = 'open',
          dispatch_status = 'open',
          agent_identity = NULL,
          claim_token = gen_random_uuid(),
          claim_expires_at = NULL,
          claimed_at = NULL,
          last_renewed_at = NULL,
          renew_count = 0,
          reissue_count = reissue_count + 1,
          offer_version = offer_version + 1,
          lease_id = NULL
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at = now(), release_reason = 'lease_expired'
      WHERE proposal_id = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      v_reissued := v_reissued + 1;
      PERFORM pg_notify('work_offers',
        json_build_object('event','reissued','dispatch_id', v_row.id)::text);
    ELSE
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status = 'expired',
          dispatch_status = 'failed',
          completed_at = now(),
          failure_class = 'lease_expired',        -- V3-C2
          failure_is_transient = true,            -- V3-C2: capacity, not a loop
          metadata = metadata || jsonb_build_object('failure_reason', 'lease_expired')
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at = now(), release_reason = 'lease_expired'
      WHERE proposal_id = v_row.proposal_id
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

COMMIT;
