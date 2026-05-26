-- P440: Dispatch Retry and Terminal Semantics
--
-- Adds an explicit retry lifecycle to squad_dispatch:
--   • retry_policy table with exponential-backoff config
--   • attempt_count / last_attempt_at / next_retry_at / retry_policy_ref columns
--   • Canonical dispatch_status values: posted, claimed, running, retry_wait,
--     failed, cancelled, completed — all terminal states immutable after set
--   • fn_record_dispatch_failure: classify error → retry_wait or failed + pg_notify
--   • fn_requeue_ready_dispatches: flip retry_wait → posted when cooldown expires
--   • fn_claim_work_offer (5-param overload): belt-and-suspenders terminal +
--     cooldown exclusion guards in the candidate SELECT

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1: Extend dispatch_status constraint to P440 canonical values
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Drop the old strict check if it exists so the NOT VALID version is sole owner.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'squad_dispatch_status_check_strict'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      DROP CONSTRAINT squad_dispatch_status_check_strict;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'squad_dispatch_status_check'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT squad_dispatch_status_check CHECK (
        dispatch_status IN (
          'open','assigned','active','blocked',
          'posted','claimed','running','retry_wait',
          'failed','cancelled','completed'
        )
      ) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2: New columns on squad_dispatch
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS attempt_count      INT         NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS last_attempt_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_policy_ref   BIGINT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3: retry_policy table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_workforce.retry_policy (
  policy_id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_name             TEXT        NOT NULL,
  max_attempts            INT         NOT NULL DEFAULT 5  CHECK (max_attempts > 0),
  base_cooldown_seconds   INT         NOT NULL DEFAULT 30 CHECK (base_cooldown_seconds > 0),
  backoff_multiplier      NUMERIC(5,2) NOT NULL DEFAULT 2.0 CHECK (backoff_multiplier >= 1.0),
  retryable_error_classes JSONB       NOT NULL DEFAULT '[]',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT retry_policy_name_unique UNIQUE (policy_name)
);

-- Seed: 'default' policy (idempotent)
INSERT INTO roadmap_workforce.retry_policy
  (policy_name, max_attempts, base_cooldown_seconds, backoff_multiplier, retryable_error_classes)
VALUES
  ('default', 5, 30, 2.0, '["TIMEOUT","TRANSIENT_ERROR","RESOURCE_UNAVAILABLE"]')
ON CONFLICT (policy_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4: FK retry_policy_ref → retry_policy (SET NULL on delete)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'squad_dispatch_retry_policy_ref_fkey'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT squad_dispatch_retry_policy_ref_fkey
      FOREIGN KEY (retry_policy_ref)
      REFERENCES roadmap_workforce.retry_policy(policy_id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5: Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_retry_wait
  ON roadmap_workforce.squad_dispatch (next_retry_at)
  WHERE dispatch_status = 'retry_wait' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_squad_dispatch_terminal_status
  ON roadmap_workforce.squad_dispatch (dispatch_status, id DESC)
  WHERE dispatch_status IN ('failed', 'cancelled', 'completed');

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6: fn_record_dispatch_failure
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_record_dispatch_failure(
  p_dispatch_id  BIGINT,
  p_error_class  TEXT,
  p_error_detail TEXT DEFAULT NULL
)
RETURNS TABLE (
  out_dispatch_id   BIGINT,
  out_dispatch_status TEXT,
  out_attempt_count INT,
  out_next_retry_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
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
  SELECT * INTO v_row
  FROM roadmap_workforce.squad_dispatch
  WHERE id = p_dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_record_dispatch_failure: dispatch % not found', p_dispatch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.dispatch_status IN ('failed', 'cancelled', 'completed') THEN
    RAISE EXCEPTION
      'fn_record_dispatch_failure: dispatch % is in terminal state ''%'' and cannot receive new failures',
      p_dispatch_id, v_row.dispatch_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_new_attempt := COALESCE(v_row.attempt_count, 0) + 1;

  -- Load policy: explicit reference → 'default' row → hard-coded fallback
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

  IF v_policy_id IS NULL THEN
    v_max_attempts := 5;
    v_cooldown     := 30;
    v_multiplier   := 2.0;
    v_classes      := '[]'::jsonb;
  END IF;

  v_is_retryable := (
    v_classes IS NOT NULL
    AND jsonb_typeof(v_classes) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_classes) c(cls)
      WHERE c.cls = p_error_class
    )
  );

  IF v_is_retryable AND v_new_attempt <= v_max_attempts THEN
    v_new_status := 'retry_wait';
    v_next_retry := now() + (
      least(v_cooldown * power(v_multiplier, v_new_attempt - 1), 3600.0)
    )::int * interval '1 second';
  ELSE
    v_new_status := 'failed';
    v_next_retry := NULL;
    PERFORM pg_notify(
      'reissue_required',
      json_build_object(
        'dispatch_id',   p_dispatch_id,
        'proposal_id',   v_row.proposal_id,
        'attempt_count', v_new_attempt,
        'error_class',   p_error_class,
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

  RETURN QUERY SELECT p_dispatch_id, v_new_status, v_new_attempt, v_next_retry;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7: fn_requeue_ready_dispatches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_requeue_ready_dispatches()
RETURNS TABLE (out_dispatch_id BIGINT)
LANGUAGE plpgsql AS $$
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8: fn_claim_work_offer — P440 belt-and-suspenders guards
--   Only the 5-param overload (p_host) is modified; it is the live callee.
--   Guards added to candidate SELECT:
--     • dispatch_status NOT IN terminal set  (defense-in-depth vs offer_status)
--     • next_retry_at IS NULL OR <= now()    (cooldown exclusion)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity       TEXT,
  p_required_capabilities JSONB    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds    INT      DEFAULT 20,
  p_project_id           BIGINT   DEFAULT NULL,
  p_host                 TEXT     DEFAULT NULL
)
RETURNS TABLE (
  dispatch_id      BIGINT,
  proposal_id      BIGINT,
  squad_name       TEXT,
  dispatch_role    TEXT,
  claim_token      UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version    INT,
  metadata         JSONB
)
LANGUAGE plpgsql AS $$
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

  SELECT ar.id, ar.status, ar.agent_type, COALESCE(ar.max_concurrent_claims, 3)
    INTO v_agency_id, v_agency_status, v_agency_type, v_max_claims
    FROM roadmap_workforce.agent_registry ar
   WHERE ar.agent_identity = p_agent_identity;

  v_is_coordinator := (v_agency_type = 'coordinator');

  -- Gate 1: agency must be active
  IF v_agency_status IS DISTINCT FROM 'active' THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'INACTIVE_AGENCY',
            format('agency %s has status %s', p_agent_identity, v_agency_status));
    RETURN;
  END IF;

  -- Gate 2: concurrency ceiling
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
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9: Grants
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON roadmap_workforce.retry_policy TO xiaomi;
GRANT EXECUTE ON FUNCTION roadmap_workforce.fn_record_dispatch_failure(BIGINT, TEXT, TEXT) TO xiaomi;
GRANT EXECUTE ON FUNCTION roadmap_workforce.fn_requeue_ready_dispatches() TO xiaomi;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 10: Post-migration validation
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_ok BOOLEAN := TRUE;
  v_msg TEXT;
BEGIN
  -- retry_policy table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'retry_policy'
  ) THEN
    v_ok := FALSE; v_msg := 'retry_policy table missing';
  END IF;

  -- default seed row present
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.retry_policy WHERE policy_name = 'default'
  ) THEN
    v_ok := FALSE; v_msg := 'default retry_policy row missing';
  END IF;

  -- Required columns on squad_dispatch
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'squad_dispatch'
      AND column_name = 'attempt_count'
  ) THEN
    v_ok := FALSE; v_msg := 'squad_dispatch.attempt_count column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'squad_dispatch'
      AND column_name = 'next_retry_at'
  ) THEN
    v_ok := FALSE; v_msg := 'squad_dispatch.next_retry_at column missing';
  END IF;

  -- Functions callable
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce' AND p.proname = 'fn_record_dispatch_failure'
  ) THEN
    v_ok := FALSE; v_msg := 'fn_record_dispatch_failure not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce' AND p.proname = 'fn_requeue_ready_dispatches'
  ) THEN
    v_ok := FALSE; v_msg := 'fn_requeue_ready_dispatches not found';
  END IF;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'P440 migration validation failed: %', v_msg;
  END IF;

  RAISE NOTICE 'P440 migration 068 validation passed.';
END $$;

COMMIT;
