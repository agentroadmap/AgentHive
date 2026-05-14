-- Migration 151: fn_return_work_offer — graceful claim retraction
--
-- Per operator policy (2026-05-14):
--   "Claim is calculated intention; if there is obstacle, agency can regret
--    and return the offer."
--
-- The existing fn_complete_work_offer accepts only 'delivered' or 'failed'.
-- Using 'failed' for a busy-decline pollutes failure metrics, counts against
-- max_reissues=3, and conflates "agent tried and broke it" with "agent
-- doesn't have capacity right now." This migration adds a third path so the
-- agency can hand the offer back without that pollution.
--
-- Behavior:
--   - Reverts squad_dispatch.offer_status from 'claimed'/'active' back to 'open'
--   - Rotates the claim_token (old token is now invalid; any in-flight spawn
--     racing on the old token will get 0 rows from fn_complete_work_offer)
--   - Clears claimed_at, claim_expires_at, last_renewed_at
--   - Does NOT increment reissue_count or failure_count
--   - Tags metadata.return_reason / returned_by / returned_at for audit
--   - Emits pg_notify('work_offers') so any LISTEN-ing claimer wakes up
--     immediately to re-claim
--   - Returns the proposal_lease row (release_reason='agent_returned')

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_return_work_offer(
  p_dispatch_id    BIGINT,
  p_agent_identity TEXT,
  p_claim_token    UUID,
  p_reason         TEXT DEFAULT 'unspecified'
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated   INT;
BEGIN
  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status     = 'open',
      dispatch_status  = 'open',
      claim_token      = gen_random_uuid(),
      claimed_at       = NULL,
      claim_expires_at = NULL,
      last_renewed_at  = NULL,
      metadata = metadata || jsonb_build_object(
        'return_reason', p_reason,
        'returned_by',   p_agent_identity,
        'returned_at',   to_jsonb(now())
      )
  WHERE id           = p_dispatch_id
    AND (agent_identity   = p_agent_identity
         OR agency_identity = p_agent_identity)
    AND claim_token    = p_claim_token
    AND offer_status  IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    -- Release any proposal_lease tied to this dispatch — release_reason marks
    -- it as a voluntary return so dashboards can distinguish from real failures.
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = 'agent_returned'
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;

    -- Wake up the claim loop so the offer is re-claimed promptly instead of
    -- waiting for the next poll cycle.
    PERFORM pg_notify('work_offers', json_build_object(
      'dispatch_id', p_dispatch_id,
      'event',       'returned',
      'reason',      p_reason
    )::text);
  END IF;

  RETURN v_updated = 1;
END;
$function$;

COMMENT ON FUNCTION roadmap_workforce.fn_return_work_offer IS
  'Agency-side claim retraction. Returns offer to ''open'' state without '
  'incrementing failure counters or max_reissues. Use when an agency declines '
  'a dispatch due to capacity, transient obstacle, or other non-error reasons. '
  'Added 2026-05-14 (migration 151).';
