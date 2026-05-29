-- P1406 hotfix: stamp metadata.failure_reason='lease_expired' when the reaper
-- exhausts reissues. P1393 made the loop counter exclude rate_limited failures
-- (handler-stamped). This sibling does the same for capacity-exhaustion
-- failures that never spawn an agent_run (reaper-stamped).
--
-- Live evidence 2026-05-27 04:30: P1377 paused by circuit_breaker on 7 expired
-- reviewer-d1 offers, none tagged, all from claude pool saturation. Same
-- pattern at the edge for P915, P1066, P1383.

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
      SET released_at = now(),
          release_reason = 'lease_expired'
      WHERE proposal_id = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      v_reissued := v_reissued + 1;

      PERFORM pg_notify(
        'work_offers',
        json_build_object('event','reissued','dispatch_id', v_row.id)::text
      );
    ELSE
      -- P1406: stamp failure_reason='lease_expired' so post-work-offer.ts loop
      -- counter can distinguish capacity-exhaustion (transient) from real loops.
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status = 'expired',
          dispatch_status = 'failed',
          completed_at = now(),
          metadata = metadata || jsonb_build_object('failure_reason', 'lease_expired')
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at = now(),
          release_reason = 'lease_expired'
      WHERE proposal_id = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      INSERT INTO roadmap.escalation_log (
        obstacle_type, proposal_id, agent_identity, escalated_to, severity
      ) VALUES (
        'AGENT_DEAD',
        v_row.proposal_id::text,
        v_row.agent_identity,
        'orchestrator',
        'high'
      );

      v_expired := v_expired + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_reissued, v_expired;
END;
$function$;

-- Backfill: stamp existing un-marked expired rows so the loop counter doesn't
-- count them as real failures going forward. Type-safe array check skips
-- legacy rows whose required_capabilities is object-shaped (violates
-- sd_required_capabilities_nonempty CHECK on UPDATE).
UPDATE roadmap_workforce.squad_dispatch
   SET metadata = metadata || jsonb_build_object('failure_reason', 'lease_expired')
 WHERE offer_status = 'expired'
   AND dispatch_status = 'failed'
   AND COALESCE(metadata->>'failure_reason', '') = ''
   AND jsonb_typeof(required_capabilities) = 'array'
   AND jsonb_array_length(
         CASE WHEN jsonb_typeof(required_capabilities)='array'
              THEN required_capabilities
              ELSE '[]'::jsonb END
       ) > 0;
