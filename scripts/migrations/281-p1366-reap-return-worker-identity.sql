-- 281-p1366-reap-return-worker-identity.sql
-- P1366 supplement to mig 280: fix the two lifecycle stages that 280 missed.
--
-- Migration 280 sets worker_identity at claim time (fn_claim_work_offer).
-- This migration covers the reverse path — clearing worker_identity when an
-- offer is returned to 'open' state so stale identity never carries forward:
--   1. fn_reap_expired_offers: SET worker_identity = NULL in the reissue branch.
--   2. fn_return_work_offer: SET worker_identity = NULL when returning an offer.
--   3. Also re-applies fn_claim_work_offer update (idempotent) so this file is
--      self-contained if applied without 280.
--
-- Backfill: join squad_dispatch ↔ liaison_task_tracker on dispatch_id where
--   sd.worker_identity IS NULL and ltt.worker_identity IS NOT NULL.
--
-- No schema change required — column already exists (mig 041).

BEGIN;

-- ── 1. fn_claim_work_offer ─────────────────────────────────────────────────
-- Full replacement of mig 183's canonical 5-arg signature.
-- Only change: added `worker_identity = p_agent_identity` to Gate-7 UPDATE.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity        text,
  p_required_capabilities jsonb    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds     integer  DEFAULT 1320,
  p_project_id            bigint   DEFAULT NULL,
  p_host                  text     DEFAULT NULL
)
RETURNS TABLE(
  dispatch_id      bigint,
  proposal_id      bigint,
  squad_name       text,
  dispatch_role    text,
  claim_token      uuid,
  claim_expires_at timestamp with time zone,
  offer_version    integer,
  metadata         jsonb
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_picked_id      BIGINT;
  v_new_token      UUID        := gen_random_uuid();
  v_expires        TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_agency_id      BIGINT;
  v_agency_status  TEXT;
  v_agency_type    TEXT;
  v_max_claims     INT;
  v_active_claims  INT;
  v_scope_count    INT;
  v_is_coordinator BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Atomic claim: lock this agency's registry row for the duration of the
  -- transaction (mig 183 rationale: prevents CEILING TOCTOU under concurrent
  -- claimers for the same agency).
  SELECT ar.id, ar.status, ar.agent_type, COALESCE(ar.max_concurrent_claims, 3)
    INTO v_agency_id, v_agency_status, v_agency_type, v_max_claims
    FROM roadmap_workforce.agent_registry ar
   WHERE ar.agent_identity = p_agent_identity
   FOR UPDATE;

  v_is_coordinator := (v_agency_type = 'coordinator');

  -- Gate 1: agency must be active
  IF v_agency_status IS DISTINCT FROM 'active' THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'INACTIVE_AGENCY',
            format('agency %s has status %s', p_agent_identity, v_agency_status));
    RETURN;
  END IF;

  -- Gate 2: concurrency ceiling (atomic with Gate 7 via FOR UPDATE above)
  SELECT COUNT(*) INTO v_active_claims
  FROM roadmap_workforce.squad_dispatch sd2
  WHERE sd2.agent_identity = p_agent_identity
    AND sd2.offer_status IN ('claimed', 'active')
    AND (sd2.claim_expires_at IS NULL OR sd2.claim_expires_at > now());

  IF v_active_claims >= v_max_claims THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'CONCURRENCY_EXCEEDED',
            format('agency %s holds %s/%s active claims',
                   p_agent_identity, v_active_claims, v_max_claims));
    RETURN;
  END IF;

  -- Gate 3: host route policy
  IF p_host IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.model_routes mr
      WHERE mr.is_enabled = true
        AND roadmap.fn_check_spawn_policy(p_host, mr.route_provider)
      LIMIT 1
    ) THEN
      INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
      VALUES (v_agency_id, 'POLICY_VIOLATION',
              format('host %s has no enabled routes', p_host));
      RETURN;
    END IF;
  END IF;

  -- Gate 5: budget circuit breaker
  IF EXISTS (
    SELECT 1 FROM roadmap_efficiency.budget_circuit_breaker
    WHERE status = 'tripped'
      AND tripped_at IS NOT NULL
      AND reset_at IS NULL
  ) THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'BUDGET_EXHAUSTED', 'global budget circuit breaker is tripped');
    RETURN;
  END IF;

  -- Gate 6: project scope (skipped for coordinators)
  IF NOT v_is_coordinator THEN
    SELECT COUNT(*) INTO v_scope_count
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
      AND (p_project_id IS NULL OR pr.project_id = p_project_id);

    IF v_scope_count = 0 THEN
      INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
      VALUES (v_agency_id, 'UNKNOWN_SCOPE',
              format('agency %s is not subscribed to project %s',
                     p_agent_identity, COALESCE(p_project_id::text, '(any)')));
      RETURN;
    END IF;
  END IF;

  -- Gate 7: pick candidate
  SELECT sd.id INTO v_picked_id
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
    AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')
    AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())
    AND (p_project_id IS NULL OR sd.project_id = p_project_id)
    AND (
      v_is_coordinator
      OR p_required_capabilities = '[]'::jsonb
      OR sd.required_capabilities @> p_required_capabilities
      OR p_required_capabilities @> sd.required_capabilities
    )
  ORDER BY sd.assigned_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_picked_id IS NULL THEN
    RETURN;
  END IF;

  -- P1366: worker_identity is now set at claim time so Cockpit attribution
  -- and audit trails are populated before the agency actually spawns.
  UPDATE roadmap_workforce.squad_dispatch sd
  SET agent_identity   = p_agent_identity,
      agency_identity  = p_agent_identity,
      worker_identity  = p_agent_identity,
      claim_token      = v_new_token,
      claim_expires_at = v_expires,
      claimed_at       = now(),
      last_renewed_at  = now(),
      offer_status     = 'claimed',
      dispatch_status  = 'assigned'
  WHERE sd.id = v_picked_id
  RETURNING sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
            sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  INTO dispatch_id, proposal_id, squad_name, dispatch_role,
       claim_token, claim_expires_at, offer_version, metadata;

  RETURN NEXT;
  RETURN;
END;
$function$;

-- ── 2. fn_reap_expired_offers ──────────────────────────────────────────────
-- Full replacement of mig 181's version.
-- Only change: added `worker_identity = NULL` in the reissue branch so a
-- returned-to-open offer does not carry the previous claimant's identity.

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

      PERFORM pg_notify(
        'work_offers',
        json_build_object('event','reissued','dispatch_id', v_row.id)::text
      );
    ELSE
      -- Stamp failure_reason='lease_expired' (mig 181/P1406) so post-work-offer.ts
      -- loop counter can distinguish capacity-exhaustion (transient) from real loops.
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status    = 'expired',
          dispatch_status = 'failed',
          completed_at    = now(),
          metadata        = metadata || jsonb_build_object('failure_reason', 'lease_expired')
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

-- ── 3. fn_return_work_offer ────────────────────────────────────────────────
-- Full replacement of mig 153's version.
-- Only change: added `worker_identity = NULL` so a voluntarily-returned offer
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
      metadata = metadata || jsonb_build_object(
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

-- ── 4. Backfill ────────────────────────────────────────────────────────────
-- Populate worker_identity from liaison_task_tracker for rows where the
-- tracker recorded a spawn but squad_dispatch still shows NULL.
-- Restricted to non-terminal offers so we don't stamp closed history rows.
UPDATE roadmap_workforce.squad_dispatch sd
   SET worker_identity = ltt.worker_identity
  FROM roadmap.liaison_task_tracker ltt
 WHERE sd.id               = ltt.dispatch_id
   AND sd.worker_identity  IS NULL
   AND ltt.worker_identity IS NOT NULL
   AND sd.offer_status NOT IN ('expired', 'delivered', 'failed');

COMMIT;
