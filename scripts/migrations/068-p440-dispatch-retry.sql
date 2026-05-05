-- ============================================================
-- Migration 068 — P440: Dispatch Retry and Terminal Semantics
-- Adds attempt counters, retry policy, and terminal state machine
-- to squad_dispatch. Introduces fn_record_dispatch_failure which
-- classifies errors, increments attempt_count on the same row,
-- sets retry_wait + cooldown, or marks failed + emits reissue_required.
-- ============================================================
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
--             CREATE OR REPLACE FUNCTION, constraint guards via DO blocks.
-- Run in transaction; rolls back cleanly on any step failure.
-- Prerequisites: migration 067 (control_audit, fn_claim_work_offer 7-gate).
--
-- Source of truth: roadmap_workforce.squad_dispatch in the agenthive DB.
-- Migration/compatibility boundary: all existing dispatch_status values
--   (open, assigned, active, blocked, completed, cancelled, failed) are
--   preserved in the CHECK constraint; new values are additive.
--   fn_claim_work_offer is updated in-place (CREATE OR REPLACE), backward-
--   compatible because the new conditions only restrict rows that would not
--   have been claimable anyway in a correctly-running system.
-- ============================================================

BEGIN;

-- ── Step 1: Extend dispatch_status CHECK constraint ──────────
-- P440 canonical values: posted, claimed, running, retry_wait,
--                        failed, cancelled, completed.
-- Legacy values (migration 038) preserved: open, assigned, active, blocked.
-- The CHECK is rebuilt as NOT VALID to avoid a full-table scan on historical
-- rows; new INSERTs and UPDATEs are enforced immediately.

ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_status_check;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_status_check
  CHECK (dispatch_status IN (
    -- legacy values preserved for backward compatibility
    'open', 'assigned', 'active', 'blocked',
    -- P440 canonical lifecycle values
    'posted', 'claimed', 'running', 'retry_wait',
    -- terminal values
    'completed', 'cancelled', 'failed'
  )) NOT VALID;

-- ── Step 2: Add retry columns to squad_dispatch ──────────────

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS attempt_count    INT          NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS last_attempt_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_policy_ref BIGINT;
-- FK added after retry_policy table creation in Step 4.

-- ── Step 3: Create retry_policy table ────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_workforce.retry_policy (
  policy_id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_name             TEXT         NOT NULL,
  max_attempts            INT          NOT NULL DEFAULT 5
    CONSTRAINT retry_policy_max_attempts_pos CHECK (max_attempts > 0),
  base_cooldown_seconds   INT          NOT NULL DEFAULT 30
    CONSTRAINT retry_policy_cooldown_pos CHECK (base_cooldown_seconds > 0),
  backoff_multiplier      NUMERIC(5,2) NOT NULL DEFAULT 2.0
    CONSTRAINT retry_policy_multiplier_gte1 CHECK (backoff_multiplier >= 1.0),
  retryable_error_classes JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT retry_policy_name_unique UNIQUE (policy_name)
);

COMMENT ON TABLE roadmap_workforce.retry_policy IS
  'P440: Per-dispatch retry policy. max_attempts: how many times a dispatch '
  'can be retried before being marked failed. retryable_error_classes: JSONB '
  'array of error class strings (e.g. ["TIMEOUT","TRANSIENT_ERROR"]). '
  'backoff_multiplier: exponential factor applied to base_cooldown_seconds.';

-- Default policy used when squad_dispatch.retry_policy_ref IS NULL.
INSERT INTO roadmap_workforce.retry_policy
  (policy_name, max_attempts, base_cooldown_seconds, backoff_multiplier, retryable_error_classes)
VALUES
  ('default', 5, 30, 2.0, '["TIMEOUT","TRANSIENT_ERROR","AGENT_DEAD"]'::jsonb)
ON CONFLICT (policy_name) DO NOTHING;

-- ── Step 4: FK from squad_dispatch to retry_policy ───────────
-- ON DELETE SET NULL: deleting a policy does not cascade-fail dispatches;
-- they fall back to the hard-coded defaults in fn_record_dispatch_failure.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname     = 'squad_dispatch_retry_policy_ref_fkey'
      AND conrelid    = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT squad_dispatch_retry_policy_ref_fkey
      FOREIGN KEY (retry_policy_ref)
      REFERENCES roadmap_workforce.retry_policy (policy_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── Step 5: Indexes for retry scanning ───────────────────────

-- Requeue scan: fn_requeue_ready_dispatches finds rows ready to be re-posted.
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_retry_ready
  ON roadmap_workforce.squad_dispatch (next_retry_at ASC)
  WHERE dispatch_status = 'retry_wait' AND next_retry_at IS NOT NULL;

-- Terminal state audit: fast lookup on terminal rows.
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_terminal_status
  ON roadmap_workforce.squad_dispatch (dispatch_status, id DESC)
  WHERE dispatch_status IN ('failed', 'cancelled', 'completed');

-- ── Step 6: fn_record_dispatch_failure ───────────────────────
-- Records a worker failure for a dispatch row. Increments attempt_count
-- on the SAME row (no replacement rows, full audit trail in place).
--
-- Decision logic:
--   1. If p_error_class is in policy.retryable_error_classes
--      AND new attempt_count <= policy.max_attempts
--        → dispatch_status = 'retry_wait',  offer_status = 'expired',
--          next_retry_at = now() + exponential_backoff
--   2. Otherwise (non-retryable OR attempt limit reached)
--        → dispatch_status = 'failed', offer_status = 'failed',
--          pg_notify('reissue_required', JSON)
--
-- Terminal rows (failed/cancelled/completed) raise an exception — callers
-- must not re-report failures for finished work.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_record_dispatch_failure(
  p_dispatch_id  BIGINT,
  p_error_class  TEXT,
  p_error_detail TEXT  DEFAULT NULL
)
RETURNS TABLE(
  out_dispatch_id     BIGINT,
  out_dispatch_status TEXT,
  out_attempt_count   INT,
  out_next_retry_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row          roadmap_workforce.squad_dispatch%ROWTYPE;
  v_policy_id    BIGINT;
  v_max_attempts INT;
  v_cooldown     INT;
  v_multiplier   NUMERIC;
  v_classes      JSONB;
  v_new_attempt  INT;
  v_is_retryable BOOLEAN;
  v_new_status   TEXT;
  v_next_retry   TIMESTAMPTZ;
BEGIN
  -- Lock the row exclusively to prevent concurrent failure reports.
  SELECT * INTO v_row
  FROM roadmap_workforce.squad_dispatch
  WHERE id = p_dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_record_dispatch_failure: dispatch % not found', p_dispatch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Terminal states are immutable — reject the call.
  IF v_row.dispatch_status IN ('failed', 'cancelled', 'completed') THEN
    RAISE EXCEPTION
      'fn_record_dispatch_failure: dispatch % is in terminal state ''%'' and cannot receive new failures',
      p_dispatch_id, v_row.dispatch_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_new_attempt := COALESCE(v_row.attempt_count, 0) + 1;

  -- Load policy: explicit reference takes priority, then 'default', then hard-coded fallback.
  IF v_row.retry_policy_ref IS NOT NULL THEN
    SELECT policy_id, max_attempts, base_cooldown_seconds, backoff_multiplier, retryable_error_classes
    INTO v_policy_id, v_max_attempts, v_cooldown, v_multiplier, v_classes
    FROM roadmap_workforce.retry_policy
    WHERE policy_id = v_row.retry_policy_ref;
  END IF;

  IF v_policy_id IS NULL THEN
    SELECT policy_id, max_attempts, base_cooldown_seconds, backoff_multiplier, retryable_error_classes
    INTO v_policy_id, v_max_attempts, v_cooldown, v_multiplier, v_classes
    FROM roadmap_workforce.retry_policy
    WHERE policy_name = 'default';
  END IF;

  -- Hard-coded fallback when no policy row exists at all.
  IF v_policy_id IS NULL THEN
    v_max_attempts := 5;
    v_cooldown     := 30;
    v_multiplier   := 2.0;
    v_classes      := '[]'::jsonb;
  END IF;

  -- Classify error: retryable if p_error_class appears in retryable_error_classes array.
  v_is_retryable := (
    v_classes IS NOT NULL
    AND jsonb_typeof(v_classes) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_classes) c(cls)
      WHERE c.cls = p_error_class
    )
  );

  IF v_is_retryable AND v_new_attempt <= v_max_attempts THEN
    -- Retryable and within attempt limit → schedule retry.
    v_new_status := 'retry_wait';
    -- Exponential backoff capped at 1 hour: cooldown * multiplier^(attempt-1)
    v_next_retry := now() + (
      least(v_cooldown * power(v_multiplier, v_new_attempt - 1), 3600.0)
    )::int * interval '1 second';
  ELSE
    -- Non-retryable or attempt limit exceeded → terminal failure.
    v_new_status := 'failed';
    v_next_retry := NULL;
    -- Notify the orchestrator to create a fresh dispatch with a new idempotency key.
    PERFORM pg_notify(
      'reissue_required',
      json_build_object(
        'dispatch_id',  p_dispatch_id,
        'proposal_id',  v_row.proposal_id,
        'attempt_count', v_new_attempt,
        'error_class',  p_error_class,
        'reason', CASE
          WHEN NOT v_is_retryable THEN 'non_retryable_error'
          ELSE 'max_attempts_exceeded'
        END
      )::text
    );
  END IF;

  UPDATE roadmap_workforce.squad_dispatch
  SET dispatch_status = v_new_status,
      offer_status    = CASE
                          WHEN v_new_status = 'retry_wait' THEN 'expired'
                          ELSE 'failed'
                        END,
      attempt_count   = v_new_attempt,
      last_attempt_at = now(),
      next_retry_at   = v_next_retry
  WHERE id = p_dispatch_id;

  RETURN QUERY
  SELECT p_dispatch_id, v_new_status, v_new_attempt, v_next_retry;
END;
$$;

-- ── Step 7: fn_requeue_ready_dispatches ──────────────────────
-- Promotes retry_wait rows whose cooldown has expired back to
-- offer_status='open' so fn_claim_work_offer can pick them up.
-- Called by pipeline-cron or the orchestrator on each poll cycle.
-- Returns the IDs of all requeued dispatches.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_requeue_ready_dispatches()
RETURNS TABLE(out_dispatch_id BIGINT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE roadmap_workforce.squad_dispatch
  SET dispatch_status = 'posted',
      offer_status    = 'open',
      next_retry_at   = NULL
  WHERE dispatch_status = 'retry_wait'
    AND next_retry_at IS NOT NULL
    AND next_retry_at <= now()
  RETURNING id;
END;
$$;

-- ── Step 8: Harden fn_claim_work_offer — terminal + cooldown guards ─
-- P440 adds two belt-and-suspenders conditions to the candidate CTE:
--   1. dispatch_status NOT IN ('failed','cancelled','completed')
--      — terminal dispatches cannot be claimed even if offer_status
--        were somehow 'open' due to a race or operator error.
--   2. next_retry_at IS NULL OR next_retry_at <= now()
--      — respect retry cooldown; fn_requeue_ready_dispatches is the
--        normal promotion path but the claim function enforces it too.
-- All 7 gates from migration 067 are preserved unchanged.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity         TEXT,
  p_required_capabilities  JSONB    DEFAULT '[]'::JSONB,
  p_lease_ttl_seconds      INT      DEFAULT 20,
  p_project_id             BIGINT   DEFAULT NULL,
  p_host                   TEXT     DEFAULT NULL
)
RETURNS TABLE(
  dispatch_id      BIGINT,
  proposal_id      BIGINT,
  squad_name       TEXT,
  dispatch_role    TEXT,
  claim_token      UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version    INT,
  metadata         JSONB
)
LANGUAGE plpgsql
AS $$
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
  -- ── Gate 1: agent must be registered ───────────────────────
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

  -- ── Gate 2: agency must be active ──────────────────────────
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

  -- ── Gate 3: concurrent claim limit ─────────────────────────
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

  -- ── Gate 4: host spawn policy (skipped when p_host IS NULL) ─
  IF p_host IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.model_routes mr
      WHERE mr.is_enabled = true
        AND roadmap.fn_check_spawn_policy(p_host, mr.provider)
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

  -- ── Gate 5: budget circuit breaker ─────────────────────────
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

  -- ── Gate 6: project scope check ────────────────────────────
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

  -- ── Candidate SELECT: Gate 7 (capability) applied inline ───
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
      -- P440: terminal dispatch_status rows cannot be claimed
      AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')
      -- P440: respect retry cooldown window
      AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())
      -- Project scope
      AND (
        (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
        OR (p_project_id IS NULL  AND sd.project_id IN (SELECT project_id FROM agency_projects))
      )
      -- Capability gate: "general" sentinel means any agency is eligible
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
$$;

-- ── Step 9: Grants ─────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON roadmap_workforce.retry_policy TO xiaomi;
GRANT USAGE ON SEQUENCE roadmap_workforce.retry_policy_policy_id_seq TO xiaomi;

-- ── Step 10: Post-migration validation ────────────────────────

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify dispatch_status CHECK constraint exists (was dropped and re-added).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'squad_dispatch_status_check'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    RAISE EXCEPTION 'P440 validation: squad_dispatch_status_check constraint missing';
  END IF;

  -- Verify all four new columns exist.
  SELECT COUNT(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'roadmap_workforce'
    AND table_name   = 'squad_dispatch'
    AND column_name IN ('attempt_count', 'last_attempt_at', 'next_retry_at', 'retry_policy_ref');
  IF v_count < 4 THEN
    RAISE EXCEPTION 'P440 validation: only %/4 new squad_dispatch columns found', v_count;
  END IF;

  -- Verify retry_policy table exists.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap_workforce'
      AND table_name   = 'retry_policy'
  ) THEN
    RAISE EXCEPTION 'P440 validation: retry_policy table missing';
  END IF;

  -- Verify default policy was seeded.
  SELECT COUNT(*) INTO v_count
  FROM roadmap_workforce.retry_policy
  WHERE policy_name = 'default';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'P440 validation: default retry_policy row missing';
  END IF;

  -- Verify fn_record_dispatch_failure exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce'
      AND p.proname = 'fn_record_dispatch_failure'
  ) THEN
    RAISE EXCEPTION 'P440 validation: fn_record_dispatch_failure function missing';
  END IF;

  -- Verify fn_requeue_ready_dispatches exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce'
      AND p.proname = 'fn_requeue_ready_dispatches'
  ) THEN
    RAISE EXCEPTION 'P440 validation: fn_requeue_ready_dispatches function missing';
  END IF;

  RAISE NOTICE 'P440 validation: all checks passed';
END $$;

COMMIT;
