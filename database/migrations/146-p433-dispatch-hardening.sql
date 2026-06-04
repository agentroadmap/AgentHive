-- Migration 146: P433 — Dispatch and Agency Hardening
--
-- Summary:
--   Stable agencies, ephemeral workers, fail-closed claims.
--
-- Changes:
--   1. squad_dispatch.workflow_state (TEXT, nullable) — proposal workflow state
--      captured at dispatch time; enables per-state dedup.
--
--   2. Partial UNIQUE index uniq_sd_active_dispatch:
--      (project_id, proposal_id, workflow_state, dispatch_role)
--      WHERE dispatch_status IN ('assigned','active')
--        AND workflow_state IS NOT NULL AND project_id IS NOT NULL
--      Prevents more than one active dispatch per (project, proposal, state, role).
--
--   3. NOT_ELIGIBLE added to control_audit.claim_rejection.reason_class CHECK.
--      Triggered when open offers exist for the project but the agency lacks
--      the required capabilities to claim any of them.
--
--   4. fn_claim_work_offer (5-arg): adds explicit NOT_ELIGIBLE gate (Gate 7b).
--      Two-pass pattern:
--        Pass 1 — count any open, non-terminal, non-cooling-down offers for
--                 the project scope (no capability filter).
--        Pass 2 — existing capability-filtered SKIP LOCKED pick (Gate 7a).
--        If Pass 1 > 0 AND Pass 2 returns nothing → log NOT_ELIGIBLE and return.
--
-- Source of truth: roadmap_workforce schema in the agenthive DB.
-- Migration boundary: purely additive; existing rows are unaffected.
--   workflow_state defaults to NULL; the UNIQUE index is partial (IS NOT NULL),
--   so legacy rows without workflow_state do NOT participate in the constraint.
-- Required capabilities: dispatch, agency, workflow.
--
-- Prerequisites:
--   • scripts/migrations/067-p438-claim-policy-fail-closed.sql
--     (control_audit schema, claim_rejection table, 7-gate fn_claim_work_offer)
--   • database/migrations/068-p440-dispatch-retry-terminal.sql
--     (retry lifecycle, terminal state exclusion in Gate 7)

BEGIN;

-- ── 1. workflow_state column ──────────────────────────────────────────────────

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS workflow_state TEXT;

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.workflow_state IS
  'P433: Proposal workflow state (e.g. DEVELOP, REVIEW) captured at dispatch time. '
  'Used by the active-dispatch dedup UNIQUE index. NULL for dispatches created '
  'before this migration or by callers that do not supply the value.';

-- ── 2. Active-dispatch dedup UNIQUE index ─────────────────────────────────────
--
-- Partial index: only active/assigned rows with non-NULL keys participate.
-- NULL workflow_state rows from legacy code are excluded intentionally.
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sd_active_dispatch
  ON roadmap_workforce.squad_dispatch (project_id, proposal_id, workflow_state, dispatch_role)
  WHERE dispatch_status IN ('assigned', 'active')
    AND workflow_state IS NOT NULL
    AND project_id IS NOT NULL;

COMMENT ON INDEX roadmap_workforce.uniq_sd_active_dispatch IS
  'P433 AC-1: prevents >1 active dispatch per (project, proposal, workflow_state, role). '
  'Partial: excludes NULL workflow_state (pre-migration rows) and NULL project_id.';

-- ── 3. Extend claim_rejection reason_class to include NOT_ELIGIBLE ─────────────
--
-- Drops any CHECK constraint on claim_rejection.reason_class (name auto-generated
-- by PostgreSQL from the inline CREATE TABLE definition) and replaces it with the
-- extended named constraint.  The DO block finds the actual name dynamically so
-- the drop is robust even when the auto-name differs across PostgreSQL versions.

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT c.conname INTO v_conname
  FROM   pg_constraint c
  JOIN   pg_class     t ON t.oid = c.conrelid
  JOIN   pg_namespace n ON n.oid = t.relnamespace
  JOIN   pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
  WHERE  n.nspname = 'control_audit'
    AND  t.relname = 'claim_rejection'
    AND  c.contype = 'c'            -- CHECK
    AND  a.attname = 'reason_class'
  LIMIT 1;
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE control_audit.claim_rejection DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE control_audit.claim_rejection
  ADD CONSTRAINT claim_rejection_reason_class_check
  CHECK (reason_class IN (
    'MISSING_CAPABILITY',
    'MISSING_SCOPE',
    'UNKNOWN_SCOPE',
    'EXPIRED_LEASE',
    'AMBIGUOUS_ROUTE',
    'POLICY_VIOLATION',
    'INACTIVE_AGENCY',
    'ROUTE_DISABLED',
    'BUDGET_EXHAUSTED',
    'CONCURRENCY_EXCEEDED',
    'NOT_ELIGIBLE'
  ));

COMMENT ON COLUMN control_audit.claim_rejection.reason_class IS
  'Classified rejection reason. NOT_ELIGIBLE (P433): open offers exist for the '
  'project but this agency lacks the required capabilities to claim any of them.';

-- ── 4. fn_claim_work_offer — add NOT_ELIGIBLE gate (Gate 7b) ──────────────────
--
-- Adds a two-pass capability check after existing gates 1-7:
--   Gate 7a (existing): SKIP LOCKED pick with capability filter.
--   Gate 7b (new):      if Pass-1 (open-offer count for scope) > 0 AND
--                       Pass-2 (capability-filtered pick) returns NULL
--                       → log NOT_ELIGIBLE, return 0 rows.
--
-- All other gates, parameters, and return columns are unchanged.
-- CREATE OR REPLACE preserves the existing function signature.
--
-- Design note: Pass-1 uses a plain COUNT (no lock) to detect open offers.
-- A race between Pass-1 and Pass-2 (another agency claims the offer between
-- them) may produce a spurious NOT_ELIGIBLE log entry. This is benign:
-- the audit row is evidence of contention, not a false denial.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity         text,
  p_required_capabilities  jsonb    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds      integer  DEFAULT 1320,
  p_project_id             bigint   DEFAULT NULL,
  p_host                   text     DEFAULT NULL
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
  v_open_count     INT;          -- P433: open-offer pre-scan for NOT_ELIGIBLE
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Lock the agency row for the duration of the transaction so the ceiling
  -- count in Gate 2 and the claim in Gate 7 are atomic per-agency.
  -- (P1433 / migration 183 rationale: prevents TOCTOU over-claim.)
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

  -- Gate 2: concurrency ceiling (atomic with Gate 7 via the FOR UPDATE above)
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

  -- Gate 7a: Pass-1 — count open, non-terminal offers in scope (no capability filter).
  -- Used to distinguish "no offers available" from "offers exist but caps mismatch".
  SELECT COUNT(*) INTO v_open_count
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
    AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')
    AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())
    AND (
      v_is_coordinator
      OR p_project_id IS NOT NULL AND sd.project_id = p_project_id
      OR p_project_id IS NULL AND sd.project_id IN (
          SELECT pr.project_id FROM roadmap_workforce.provider_registry pr
          WHERE pr.agency_id = v_agency_id AND pr.status = 'active'
        )
    );

  -- Gate 7a: Pass-2 — capability-filtered SKIP LOCKED pick (P440 terminal + cooldown guards)
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

  -- Gate 7b: NOT_ELIGIBLE — open offers exist but capabilities do not match.
  IF v_picked_id IS NULL AND v_open_count > 0
     AND p_required_capabilities IS DISTINCT FROM '[]'::jsonb
  THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'NOT_ELIGIBLE',
            format('agency %s lacks capabilities required by %s open offer(s) in scope; '
                   'offered=%s',
                   p_agent_identity, v_open_count,
                   p_required_capabilities::text));
    RETURN;
  END IF;

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

-- ── 5. Post-migration validation ──────────────────────────────────────────────

DO $$
DECLARE
  v_ok BOOLEAN := TRUE;
  v_msg TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name   = 'squad_dispatch'
      AND column_name  = 'workflow_state'
  ) THEN
    v_ok := FALSE; v_msg := 'workflow_state column missing from squad_dispatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'roadmap_workforce'
      AND tablename  = 'squad_dispatch'
      AND indexname  = 'uniq_sd_active_dispatch'
  ) THEN
    v_ok := FALSE; v_msg := 'uniq_sd_active_dispatch index missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname   = 'claim_rejection_reason_class_check'
      AND conrelid  = 'control_audit.claim_rejection'::regclass
  ) THEN
    v_ok := FALSE; v_msg := 'claim_rejection_reason_class_check constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce' AND p.proname = 'fn_claim_work_offer'
  ) THEN
    v_ok := FALSE; v_msg := 'fn_claim_work_offer function missing after replacement';
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'P433 migration 146 validation failed: %', v_msg;
  END IF;

  RAISE NOTICE 'P433 migration 146 validation passed.';
END $$;

COMMIT;
