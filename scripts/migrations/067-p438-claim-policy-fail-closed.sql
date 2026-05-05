-- ============================================================
-- Migration 067 — P438: Claim Policy Must Fail Closed
-- Implements fail-closed guarantee on fn_claim_work_offer:
--   - required_capabilities must be a non-empty JSONB array
--   - project_id and dispatch_role must be NOT NULL
--   - 7-gate eligibility CTE with per-rejection audit logging
--   - control_audit.claim_rejection audit table
-- ============================================================
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
--             CREATE OR REPLACE FUNCTION, constraint guards via DO blocks.
-- Run in transaction; rolls back cleanly on any step failure.
-- Prerequisites: migration 066 (provider_registry.status, agent_registry.project_id).
-- ============================================================

BEGIN;

-- ── Step 1: control_audit schema + claim_rejection table ─────

CREATE SCHEMA IF NOT EXISTS control_audit;

CREATE TABLE IF NOT EXISTS control_audit.claim_rejection (
  id            BIGSERIAL    PRIMARY KEY,
  dispatch_id   BIGINT,
  agency_id     BIGINT       NOT NULL,
  reason_class  TEXT         NOT NULL CHECK (reason_class IN (
    'MISSING_CAPABILITY',
    'MISSING_SCOPE',
    'UNKNOWN_SCOPE',
    'EXPIRED_LEASE',
    'AMBIGUOUS_ROUTE',
    'POLICY_VIOLATION',
    'INACTIVE_AGENCY',
    'ROUTE_DISABLED',
    'BUDGET_EXHAUSTED',
    'CONCURRENCY_EXCEEDED'
  )),
  reason_detail TEXT,
  rejected_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_rejection_agency
  ON control_audit.claim_rejection (agency_id, rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_rejection_dispatch
  ON control_audit.claim_rejection (dispatch_id)
  WHERE dispatch_id IS NOT NULL;

-- ── Step 2: max_concurrent_claims on agent_registry ──────────

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS max_concurrent_claims INT NOT NULL DEFAULT 3;

-- ── Step 3: Ensure provider_registry has status + agency_identity ─

-- These columns are referenced by migration 066; use IF NOT EXISTS
-- in case they were applied as a hotfix outside of scripts/migrations/.
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS agency_identity TEXT;

-- Backfill agency_identity from agent_registry where NULL
UPDATE roadmap_workforce.provider_registry pr
SET agency_identity = ar.agent_identity
FROM roadmap_workforce.agent_registry ar
WHERE ar.id = pr.agency_id
  AND pr.agency_identity IS NULL;

-- ── Step 4: Migrate required_capabilities to flat array format ─
-- Historical format: {"all":["cap1"]} or {} (object sentinels)
-- New format: ["cap1"] or ["general"] (flat JSONB array)
-- Only migrate non-terminal open/claimed rows; terminal rows are
-- excluded from new CHECK constraint via NOT VALID.

-- 4a. {"all":[...]} → [...]
UPDATE roadmap_workforce.squad_dispatch
SET required_capabilities = required_capabilities -> 'all'
WHERE offer_status IN ('open', 'claimed', 'active')
  AND jsonb_typeof(required_capabilities) = 'object'
  AND required_capabilities ? 'all'
  AND jsonb_typeof(required_capabilities -> 'all') = 'array'
  AND jsonb_array_length(required_capabilities -> 'all') > 0;

-- 4b. {} or {"all":[]} → ["general"] (open to any agency)
UPDATE roadmap_workforce.squad_dispatch
SET required_capabilities = '["general"]'::jsonb
WHERE offer_status IN ('open', 'claimed', 'active')
  AND (
    required_capabilities = '{}'::jsonb
    OR (required_capabilities ? 'all' AND jsonb_array_length(required_capabilities -> 'all') = 0)
  );

-- 4c. Any remaining non-array values among non-terminal rows → ["general"]
UPDATE roadmap_workforce.squad_dispatch
SET required_capabilities = '["general"]'::jsonb
WHERE offer_status IN ('open', 'claimed', 'active')
  AND jsonb_typeof(required_capabilities) != 'array';

-- ── Step 5: CHECK constraints on squad_dispatch (NOT VALID) ───
-- NOT VALID skips validation of existing historical rows;
-- enforces only on new INSERTs and UPDATEs going forward.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sd_required_capabilities_nonempty'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT sd_required_capabilities_nonempty CHECK (
        required_capabilities IS NOT NULL
        AND jsonb_typeof(required_capabilities) = 'array'
        AND jsonb_array_length(required_capabilities) > 0
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sd_project_id_notnull'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT sd_project_id_notnull CHECK (project_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sd_dispatch_role_notnull'
      AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
  ) THEN
    ALTER TABLE roadmap_workforce.squad_dispatch
      ADD CONSTRAINT sd_dispatch_role_notnull CHECK (dispatch_role IS NOT NULL) NOT VALID;
  END IF;
END $$;

-- ── Step 6: fn_claim_work_offer — 7-gate fail-closed ─────────
-- Gates (in order):
--   1. Agent registered (guard — RAISE on unknown identity)
--   2. Agency status = 'active'          → INACTIVE_AGENCY
--   3. Concurrent claim limit            → CONCURRENCY_EXCEEDED
--   4. Host spawn policy (opt-in)        → POLICY_VIOLATION
--   5. Budget circuit breaker            → BUDGET_EXHAUSTED
--   6. Project scope (provider_registry) → MISSING_SCOPE / UNKNOWN_SCOPE
--   7. Capability overlap (in candidate SELECT)
-- "general" in required_capabilities is a sentinel: any agency can claim.

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
  -- Count active provider_registry rows scoped to the requested project.
  -- When p_project_id IS NULL, check for any active row (will be used in
  -- candidate SELECT to pick from all subscribed projects).
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
  WITH agent_caps AS (
    SELECT ac.capability
    FROM roadmap_workforce.agent_capability ac
    JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
    WHERE ar.agent_identity = p_agent_identity
  ),
  agency_projects AS (
    -- FAIL-CLOSED: only projects the agency has explicitly joined.
    SELECT pr.project_id
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
  ),
  candidate AS (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.offer_status = 'open'
      -- Project scope
      AND (
        (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
        OR (p_project_id IS NULL  AND sd.project_id IN (SELECT project_id FROM agency_projects))
      )
      -- Capability gate: "general" is a sentinel (any agency eligible)
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

-- ── Step 7: Grants ────────────────────────────────────────────

GRANT USAGE ON SCHEMA control_audit TO xiaomi;
GRANT SELECT, INSERT ON control_audit.claim_rejection TO xiaomi;
GRANT USAGE ON SEQUENCE control_audit.claim_rejection_id_seq TO xiaomi;

-- ── Step 8: Post-migration validation ─────────────────────────

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify control_audit.claim_rejection exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'control_audit' AND table_name = 'claim_rejection'
  ) THEN
    RAISE EXCEPTION 'P438 validation: control_audit.claim_rejection table not created';
  END IF;

  -- Verify max_concurrent_claims column on agent_registry
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'agent_registry'
      AND column_name = 'max_concurrent_claims'
  ) THEN
    RAISE EXCEPTION 'P438 validation: agent_registry.max_concurrent_claims column missing';
  END IF;

  -- Verify CHECK constraints exist on squad_dispatch
  SELECT COUNT(*) INTO v_count
  FROM pg_constraint
  WHERE conrelid = 'roadmap_workforce.squad_dispatch'::regclass
    AND conname IN (
      'sd_required_capabilities_nonempty',
      'sd_project_id_notnull',
      'sd_dispatch_role_notnull'
    );
  IF v_count < 3 THEN
    RAISE EXCEPTION 'P438 validation: only %/3 CHECK constraints found on squad_dispatch', v_count;
  END IF;

  -- Verify no non-terminal rows have non-array required_capabilities
  SELECT COUNT(*) INTO v_count
  FROM roadmap_workforce.squad_dispatch
  WHERE offer_status IN ('open', 'claimed', 'active')
    AND (
      required_capabilities IS NULL
      OR jsonb_typeof(required_capabilities) != 'array'
      OR jsonb_array_length(required_capabilities) = 0
    );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'P438 validation: % non-terminal dispatch rows have invalid required_capabilities', v_count;
  END IF;

  RAISE NOTICE 'P438 validation: all checks passed';
END $$;

COMMIT;
