-- 280-p1366-worker-identity-lifecycle.sql
-- P1366: Wire worker_identity through offer/claim/coordination lifecycle.
--
-- worker_identity column already exists on squad_dispatch (migration 041/065).
-- This migration:
--   (1) Updates fn_claim_work_offer (5-arg) to set worker_identity = p_agent_identity
--       at claim time. This captures who claimed the offer before spawn completes.
--       The task-dispatcher can later overwrite it with the actual spawned worker.
--   (2) Adds a NOT VALID CHECK constraint enforcing worker_identity IS NOT NULL
--       once offer_status moves to claimed/active/delivered. NOT VALID skips
--       validation of historical rows (921 existing NULLs from before this fix).
--   (3) Backfills NULL worker_identity from liaison_task_tracker for rows that
--       already have a matching dispatch_id.
--
-- Idempotent: CREATE OR REPLACE + ADD CONSTRAINT IF NOT EXISTS.

BEGIN;

-- (1) Update fn_claim_work_offer to set worker_identity at claim time.
--     The 5-arg canonical function (migration 183 / P1433) is the only live path.
--     The legacy 4-arg overload is retired (P912/P299) and excluded (P1433 note).
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

  -- ATOMIC CLAIM: lock this agency's registry row for the duration of the
  -- transaction. Serializes the same agency's concurrent claims so the
  -- Gate-2 ceiling count below and the Gate-7 claim are atomic per-agency.
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

  -- P1366: set worker_identity = p_agent_identity at claim time.
  -- Captures the claiming agent before spawn completes. The task-dispatcher
  -- can overwrite this with the actual spawned worker identity later.
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

-- (2) CHECK constraint: once claimed/active/delivered, worker_identity must be set.
--     NOT VALID: skips validation of pre-existing NULL rows, applies to new writes only.
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT sd_worker_identity_when_claimed
  CHECK (
    offer_status NOT IN ('claimed', 'active', 'delivered')
    OR worker_identity IS NOT NULL
  )
  NOT VALID;

-- (3) Backfill NULL worker_identity from liaison_task_tracker for rows
--     that have a matching dispatch_id entry.
UPDATE roadmap_workforce.squad_dispatch sd
SET worker_identity = ltt.worker_identity
FROM roadmap.liaison_task_tracker ltt
WHERE sd.id = ltt.dispatch_id
  AND sd.worker_identity IS NULL
  AND ltt.worker_identity IS NOT NULL;

COMMIT;
