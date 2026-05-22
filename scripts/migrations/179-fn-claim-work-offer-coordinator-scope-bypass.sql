-- 179-fn-claim-work-offer-coordinator-scope-bypass.sql
--
-- Bypass Gate 6 (project scope) for coordinator agents. Coordinators
-- (orchestrator) re-dispatch claimed offers to a real worker agency whose
-- scope is then checked downstream by the matcher. They are not pinned
-- to a project themselves and don't have a heartbeat mechanism for their
-- own provider_registry rows; scanAndTransitionSilentAgencies sweeps them
-- offline every 30 minutes, which makes Gate 6 reject every subsequent
-- claim with UNKNOWN_SCOPE.
--
-- This mirrors the existing v_is_coordinator branch that already bypasses
-- Gate 7 (capability) for the same reason. The fix is one IF.
--
-- Live observation 2026-05-21: 130 UNKNOWN_SCOPE rejections in 60 minutes
-- after orchestrator restart left 24 open offers stuck in the queue,
-- exceeding MAX_GLOBAL_INFLIGHT_OFFERS=20 and triggering BackpressureError
-- on every subsequent post.

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
  -- Migration 179: also bypass Gate 6 (project scope) for the same
  -- reason. Coordinators don't belong to a project; they re-dispatch.
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

  -- Gate 3: concurrent claim limit
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

  -- Gate 4: host spawn policy
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
    WHERE tripped = true
      AND (scope = 'global' OR scope = p_agent_identity)
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

  -- Gate 6: project scope check — SKIPPED for coordinators (migration 179)
  IF NOT v_is_coordinator THEN
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
          'UNKNOWN_SCOPE',
          format('agency %s has no provider_registry rows',
                 p_agent_identity)
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
  END IF;

  -- Pick a claimable offer with SKIP LOCKED race
  SELECT sd.id INTO v_picked_id
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
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
     SET agent_identity     = p_agent_identity,
         agency_identity    = p_agent_identity,
         claim_token        = v_new_token,
         claim_expires_at   = v_expires,
         claimed_at         = now(),
         last_renewed_at    = now(),
         offer_status       = 'claimed',
         dispatch_status    = 'assigned'
   WHERE sd.id = v_picked_id
  RETURNING sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
            sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
   INTO dispatch_id, proposal_id, squad_name, dispatch_role,
        claim_token, claim_expires_at, offer_version, metadata;
  RETURN NEXT;
  RETURN;
END;
$function$;
