-- 183-p1433-atomic-claim.sql
-- V3-C1 (P1433): make the canonical fn_claim_work_offer atomic under concurrent claimers.
--
-- TWO defects fixed (verified against live DB 2026-05-29):
--
-- 1. CEILING TOCTOU. The live 5-arg fn_claim_work_offer counts an agency's active
--    claims in Gate 2, then picks+claims in Gate 7, holding NO lock on the agency
--    between the count and the claim. Two concurrent calls for the SAME agency both
--    pass Gate 2 (both see under-ceiling), both pick DIFFERENT offers via
--    FOR UPDATE SKIP LOCKED, both UPDATE -> the agency exceeds max_concurrent_claims.
--    (The offer itself is already race-safe via SKIP LOCKED; only the per-agency
--    ceiling is racy.) Fix: add FOR UPDATE to the agent_registry row resolve, which
--    serializes a single agency's concurrent claims. The second call blocks on the
--    agency row until the first commits, so its Gate-2 count includes the first's
--    new claim. Other agencies lock different rows and are unaffected. This replaces
--    the in-process-only serialization hotfix P1413 with a DB-level guarantee that
--    survives multiple liaison processes (V3 rollout steps 2-4).
--
-- 2. LEASE TTL << SPAWN TIMEOUT. Function default p_lease_ttl_seconds was 20s; the
--    live caller passes 60s; the spawn timeout is 1_200_000ms (20min). A 20-minute
--    worker renewing a 60s lease is one network/renew hiccup from a false
--    lease_expired reap. Raise the function default to 1320s (22min, just above the
--    spawn ceiling) as a safe DB-side floor. The actual fix for live behavior is the
--    TS-side DEFAULT_LEASE_TTL_SECONDS changes shipped IN THIS SAME C1 change
--    (offer-claim-loop.ts, offer-dispatch-handler.ts), because every live caller
--    passes an explicit TTL that overrides this default. Renewal cadence stays TTL/3.
--
-- DEFERRED to C6 (P1438): dropping the legacy 4-arg overload
--   fn_claim_work_offer(text,jsonb,integer,bigint). It is still referenced by the
--   RETIRED OfferProvider path (src/core/pipeline/offer-provider.ts:242, which also
--   SELECTs route_provider — a column only the 4-arg returns) and by
--   operator-stop-controls.ts:358. OfferProvider is retired (P912 AC-7 / P299) but
--   the file remains. C6 deletes that path, at which point the 4-arg overload is
--   dropped in the same reviewed change (obsolete-coupled-to-child). Dropping it
--   here would break those callers' queries. (Caught by codex review, P1433 disc #8670.)
--
-- Idempotent: CREATE OR REPLACE only (no DROP).

BEGIN;

-- (1)+(2) Canonical 5-arg claim function: agency-row FOR UPDATE serializes
--         per-agency concurrent claims; lease default raised to 1320s.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity        text,
  p_required_capabilities jsonb    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds     integer  DEFAULT 1320,   -- (3) was 20; >= spawn timeout (20min)
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

  -- (1) ATOMIC CLAIM: lock this agency's registry row for the duration of the
  --     transaction. Serializes the same agency's concurrent claims so the
  --     Gate-2 ceiling count below and the Gate-7 claim are atomic per-agency.
  --     Other agencies lock different rows; cross-agency claims stay parallel.
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

  -- Gate 2: concurrency ceiling (now atomic with Gate 7 via the FOR UPDATE above)
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

  -- Gate 4: (reserved — see migration history for removed gates)

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

  -- Gate 7: pick candidate — P440 terminal + cooldown guards
  SELECT sd.id INTO v_picked_id
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
    AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')   -- P440: terminal exclusion
    AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())           -- P440: cooldown exclusion
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

  UPDATE roadmap_workforce.squad_dispatch sd
  SET agent_identity   = p_agent_identity,
      agency_identity  = p_agent_identity,
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

COMMIT;
