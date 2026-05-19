-- Migration 142: Fix Gate 3 expiry filter in fn_claim_work_offer
--
-- Problem: Gate 3 counts ALL claimed/active rows for an agent including expired
-- ones. Zombie claimed rows (claim_expires_at in the past) permanently block new
-- claims once max_concurrent_claims is reached, because fn_reap_expired_offers
-- may not have run yet and fn_claim_work_offer re-claims the reaped rows,
-- refreshing claim_expires_at and keeping them alive.
--
-- Fix: add AND (claim_expires_at IS NULL OR claim_expires_at > now()) so only
-- non-expired claims count against the concurrency limit.
--
-- The resolver ORDER BY fix is in TypeScript (agency-resolver.ts) — no SQL change needed.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity        text,
  p_required_capabilities jsonb    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds     integer  DEFAULT 20,
  p_project_id            bigint   DEFAULT NULL::bigint,
  p_host                  text     DEFAULT NULL::text
)
RETURNS TABLE(
  dispatch_id       bigint,
  proposal_id       bigint,
  squad_name        text,
  dispatch_role     text,
  claim_token       uuid,
  claim_expires_at  timestamp with time zone,
  offer_version     integer,
  metadata          jsonb
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
  -- Gate 1: agent must be registered
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT ar.id, ar.status, ar.agent_type,
         COALESCE(ar.max_concurrent_claims, 3)
  INTO v_agency_id, v_agency_status, v_agency_type, v_max_claims
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.agent_identity = p_agent_identity;

  -- P914 Fix 2: coordinator agents bypass Gate 7 (capability) — they
  -- re-dispatch to a target agency whose caps are checked downstream.
  v_is_coordinator := (v_agency_type = 'coordinator');

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

  -- Gate 3: concurrent claim limit — only non-expired claims count.
  -- Expired claimed/active rows do not represent real in-flight work; counting
  -- them blocks new claims when fn_reap_expired_offers hasn't yet run.
  SELECT COUNT(*) INTO v_active_claims
  FROM roadmap_workforce.squad_dispatch sd2
  WHERE sd2.agent_identity = p_agent_identity
    AND sd2.offer_status IN ('claimed', 'active')
    AND (sd2.claim_expires_at IS NULL OR sd2.claim_expires_at > now());

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
        v_is_coordinator
        OR 'general' = ANY(ARRAY(SELECT jsonb_array_elements_text(sd.required_capabilities)))
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

COMMENT ON FUNCTION roadmap_workforce.fn_claim_work_offer IS
  'Atomically claim one open work offer. Gate 3 excludes expired claims from concurrency count (migration 142).';
