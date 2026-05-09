-- env: prod
-- P914 — Fix stale column reference in fn_claim_work_offer Gate 4.
-- DEPENDS ON: 100-p833-a2a-messaging-foundation.sql
-- ROLLBACK: 127-p914-fn-claim-work-offer-fix-mr-provider.rollback.sql
--
-- The host-policy gate references `mr.provider` but roadmap.model_routes has
-- `agent_provider` and `route_provider` columns (no `provider`). Every claim
-- with p_host non-null was raising `column mr.provider does not exist`,
-- which OfferClaimLoop catches and treats as "no claim available". Result:
-- no offers were ever claimed via the central orchestrator path.
--
-- Fix: pass `mr.route_provider` to fn_check_spawn_policy(p_host, p_route_provider).
-- This is the column the policy function expects per its signature
-- (p_host text, p_route_provider text).
--
-- This is a CREATE OR REPLACE — no data migration; idempotent.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity text,
  p_required_capabilities jsonb DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds integer DEFAULT 20,
  p_project_id bigint DEFAULT NULL::bigint,
  p_host text DEFAULT NULL::text
)
RETURNS TABLE(
  dispatch_id bigint,
  proposal_id bigint,
  squad_name text,
  dispatch_role text,
  claim_token uuid,
  claim_expires_at timestamp with time zone,
  offer_version integer,
  metadata jsonb
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_picked_id     BIGINT;
  v_new_token     UUID        := gen_random_uuid();
  v_expires       TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_agency_id     BIGINT;
  v_agency_status TEXT;
  v_max_claims    INT;
  v_active_claims INT;
  v_scope_count   INT;
BEGIN
  -- Gate 1: agent must be registered
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT ar.id, ar.status, COALESCE(ar.max_concurrent_claims, 3)
  INTO v_agency_id, v_agency_status, v_max_claims
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.agent_identity = p_agent_identity;

  -- Gate 2: agency must be active
  IF v_agency_status IS DISTINCT FROM 'active' THEN
    INSERT INTO control_audit.claim_rejection
      (agency_id, reason_class, reason_detail)
    VALUES (
      v_agency_id,
      'INACTIVE_AGENCY',
      format('agency %s has status %s', p_agent_identity, v_agency_status)
    );
    RETURN;
  END IF;

  -- Gate 3: concurrent claim limit
  SELECT COUNT(*) INTO v_active_claims
  FROM roadmap_workforce.squad_dispatch
  WHERE agent_identity = p_agent_identity
    AND offer_status IN ('claimed', 'active');

  IF v_active_claims >= v_max_claims THEN
    INSERT INTO control_audit.claim_rejection
      (agency_id, reason_class, reason_detail)
    VALUES (
      v_agency_id,
      'CONCURRENCY_EXCEEDED',
      format('agency %s holds %s/%s active claims',
             p_agent_identity, v_active_claims, v_max_claims)
    );
    RETURN;
  END IF;

  -- Gate 4: host spawn policy (skipped when p_host IS NULL).
  -- P914 fix: column was `mr.provider` (does not exist); the policy
  -- function takes p_route_provider, so pass mr.route_provider.
  IF p_host IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.model_routes mr
      WHERE mr.is_enabled = true
        AND roadmap.fn_check_spawn_policy(p_host, mr.route_provider)
      LIMIT 1
    ) THEN
      INSERT INTO control_audit.claim_rejection
        (agency_id, reason_class, reason_detail)
      VALUES (
        v_agency_id,
        'POLICY_VIOLATION',
        format('host %s has no enabled routes allowed by host_model_policy', p_host)
      );
      RETURN;
    END IF;
  END IF;

  -- Gate 5: budget circuit breaker
  IF EXISTS (
    SELECT 1 FROM roadmap_efficiency.budget_circuit_breaker
    WHERE status = 'tripped'
    LIMIT 1
  ) THEN
    INSERT INTO control_audit.claim_rejection
      (agency_id, reason_class, reason_detail)
    VALUES (
      v_agency_id,
      'BUDGET_EXHAUSTED',
      'global budget circuit breaker is tripped'
    );
    RETURN;
  END IF;

  -- Gate 6: project scope check
  SELECT COUNT(*) INTO v_scope_count
  FROM roadmap_workforce.provider_registry pr
  WHERE pr.agency_id = v_agency_id
    AND pr.status = 'active'
    AND (p_project_id IS NULL OR pr.project_id = p_project_id);

  IF v_scope_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap_workforce.provider_registry
      WHERE agency_id = v_agency_id
    ) THEN
      INSERT INTO control_audit.claim_rejection
        (agency_id, reason_class, reason_detail)
      VALUES (
        v_agency_id,
        'MISSING_SCOPE',
        format('agency %s has no provider_registry subscription', p_agent_identity)
      );
    ELSE
      INSERT INTO control_audit.claim_rejection
        (agency_id, reason_class, reason_detail)
      VALUES (
        v_agency_id,
        'UNKNOWN_SCOPE',
        format('agency %s is not subscribed to project %s',
               p_agent_identity, COALESCE(p_project_id::text, '(any)'))
      );
    END IF;
    RETURN;
  END IF;

  -- Candidate SELECT: Gate 7 (capability) applied inline.
  -- P440 additions (belt-and-suspenders, both additive/restrictive only):
  --   • terminal dispatch_status guard: failed/cancelled/completed rows skip
  --   • retry cooldown guard: next_retry_at in the future means not yet ready
  WITH agent_caps AS (
    SELECT ac.capability
    FROM roadmap_workforce.agent_capability ac
    JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
    WHERE ar.agent_identity = p_agent_identity
  ),
  agency_projects AS (
    SELECT pr.project_id
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
  ),
  candidate AS (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.offer_status = 'open'
      AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')
      AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())
      AND (
        (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
        OR (p_project_id IS NULL  AND sd.project_id IN (SELECT project_id FROM agency_projects))
      )
      AND (
        'general' = ANY(ARRAY(SELECT jsonb_array_elements_text(sd.required_capabilities)))
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(sd.required_capabilities) req(cap)
          WHERE req.cap NOT IN (SELECT capability FROM agent_caps)
        )
      )
    ORDER BY sd.assigned_at ASC
    FOR UPDATE OF sd SKIP LOCKED
    LIMIT 1
  )
  SELECT id INTO v_picked_id FROM candidate;

  IF v_picked_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE roadmap_workforce.squad_dispatch sd
  SET offer_status     = 'claimed',
      agent_identity   = p_agent_identity,
      agency_identity  = p_agent_identity,
      claim_token      = v_new_token,
      claim_expires_at = v_expires,
      claimed_at       = now(),
      last_renewed_at  = now(),
      offer_version    = sd.offer_version + 1
  WHERE sd.id = v_picked_id;

  RETURN QUERY
  SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
         sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.id = v_picked_id;
END;
$function$;
