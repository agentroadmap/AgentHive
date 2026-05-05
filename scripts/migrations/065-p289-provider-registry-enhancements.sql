-- P289: Provider Registry Enhancements
--
-- Implements remaining ACs:
--   AC-1: Add agency_identity, status, last_seen_at to provider_registry.
--         Fix UNIQUE constraint (NULLS NOT DISTINCT). fn_offer_provider_heartbeat().
--   AC-4: Add agency_identity to squad_dispatch (populated on claim).
--         Add FK on worker_identity → agent_registry(agent_identity).

BEGIN;

-- ─── AC-1: provider_registry enhancements ───────────────────────────────────

-- Add agency_identity — denormalized text identity for fast lookup
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS agency_identity TEXT;

-- Backfill from agent_registry
UPDATE roadmap_workforce.provider_registry pr
SET agency_identity = ar.agent_identity
FROM roadmap_workforce.agent_registry ar
WHERE ar.id = pr.agency_id
  AND pr.agency_identity IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE roadmap_workforce.provider_registry
  ALTER COLUMN agency_identity SET NOT NULL;

-- Add status column (active / paused)
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE roadmap_workforce.provider_registry
  DROP CONSTRAINT IF EXISTS provider_registry_status_check;

ALTER TABLE roadmap_workforce.provider_registry
  ADD CONSTRAINT provider_registry_status_check
    CHECK (status IN ('active', 'paused'));

-- Add last_seen_at (refreshed on each heartbeat)
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Fix UNIQUE constraint: PostgreSQL treats two NULLs as distinct by default,
-- which allows duplicate (agency_id, NULL, NULL) rows. NULLS NOT DISTINCT
-- makes NULL=NULL for uniqueness, enforcing the one-registration-per-combo rule.
ALTER TABLE roadmap_workforce.provider_registry
  DROP CONSTRAINT IF EXISTS provider_registry_agency_id_project_id_squad_name_key;

ALTER TABLE roadmap_workforce.provider_registry
  ADD CONSTRAINT provider_registry_agency_project_squad_uniq
    UNIQUE NULLS NOT DISTINCT (agency_id, project_id, squad_name);

-- Fast lookup by agency_identity
CREATE INDEX IF NOT EXISTS idx_provider_registry_agency_identity
  ON roadmap_workforce.provider_registry (agency_identity);

-- Active providers by project+squad (used by fn_claim_work_offer and detectProvider)
DROP INDEX IF EXISTS roadmap_workforce.idx_provider_registry_active;
CREATE INDEX idx_provider_registry_active
  ON roadmap_workforce.provider_registry (status, project_id, squad_name);

-- ─── fn_offer_provider_heartbeat ────────────────────────────────────────────
-- Called by OfferProvider on startup and every 30 s to maintain registration.
-- Upserts the provider_registry row for this agency, refreshing last_seen_at
-- and status='active'. Called on graceful shutdown with status='paused'.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_offer_provider_heartbeat(
  p_agency_identity TEXT,
  p_project_id      BIGINT DEFAULT NULL,
  p_squad_name      TEXT   DEFAULT NULL,
  p_capabilities    JSONB  DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_agency_id BIGINT;
BEGIN
  SELECT id INTO v_agency_id
  FROM roadmap_workforce.agent_registry
  WHERE agent_identity = p_agency_identity;

  IF v_agency_id IS NULL THEN
    RAISE EXCEPTION 'unknown agency_identity %', p_agency_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO roadmap_workforce.provider_registry
    (agency_id, agency_identity, project_id, squad_name, capabilities, status, last_seen_at)
  VALUES
    (v_agency_id, p_agency_identity, p_project_id, p_squad_name, p_capabilities, 'active', now())
  ON CONFLICT ON CONSTRAINT provider_registry_agency_project_squad_uniq DO UPDATE SET
    agency_identity = p_agency_identity,
    capabilities    = EXCLUDED.capabilities,
    status          = 'active',
    last_seen_at    = now(),
    updated_at      = now();
END;
$fn$;

-- ─── AC-4: squad_dispatch.agency_identity ───────────────────────────────────
-- Populated on claim (fn_claim_work_offer sets this alongside legacy agent_identity).
-- Legacy agent_identity remains for backwards compatibility.

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS agency_identity TEXT;

-- FK enforcement for new rows; NOT VALID skips scan of existing rows
ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_agency_identity_fkey2;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_agency_identity_fkey2
    FOREIGN KEY (agency_identity)
    REFERENCES roadmap_workforce.agent_registry(agent_identity)
    NOT VALID;

-- Backfill agency_identity from existing agent_identity (on non-null rows)
UPDATE roadmap_workforce.squad_dispatch
SET agency_identity = agent_identity
WHERE agency_identity IS NULL
  AND agent_identity IS NOT NULL;

-- FK enforcement on worker_identity; NOT VALID skips existing rows
ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_worker_identity_fkey;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_worker_identity_fkey
    FOREIGN KEY (worker_identity)
    REFERENCES roadmap_workforce.agent_registry(agent_identity)
    NOT VALID;

-- ─── Update fn_claim_work_offer to set agency_identity alongside agent_identity

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity       TEXT,
  p_required_capabilities JSONB DEFAULT '{}'::jsonb,
  p_lease_ttl_seconds    INT   DEFAULT 20,
  p_project_id           BIGINT DEFAULT NULL
)
RETURNS TABLE (
  dispatch_id     BIGINT,
  proposal_id     BIGINT,
  squad_name      TEXT,
  dispatch_role   TEXT,
  claim_token     UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version   INT,
  metadata        JSONB
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_picked_id BIGINT;
  v_new_token UUID := gen_random_uuid();
  v_expires   TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_agency_id BIGINT;
BEGIN
  -- Verify caller is a registered agent
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Get agency_id for project scoping
  SELECT ar.id INTO v_agency_id
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.agent_identity = p_agent_identity;

  -- Pick one open offer whose required_capabilities are satisfied by this
  -- agent's agent_capability rows, scoped to projects the agency has joined.
  -- SKIP LOCKED lets concurrent claimers race without blocking.
  WITH agent_caps AS (
    SELECT ac.capability
    FROM roadmap_workforce.agent_capability ac
    JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
    WHERE ar.agent_identity = p_agent_identity
  ),
  agency_projects AS (
    -- Projects this agency has joined (via provider_registry)
    SELECT pr.project_id
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
    UNION
    -- If no project filter, allow all projects (backward compat)
    SELECT id FROM roadmap_workforce.projects
    WHERE p_project_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM roadmap_workforce.provider_registry pr2
        WHERE pr2.agency_id = v_agency_id AND pr2.status = 'active'
      )
  ),
  candidate AS (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.offer_status = 'open'
      -- Project scoping: either specific project or agency's subscribed projects
      AND (
        (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
        OR (p_project_id IS NULL AND sd.project_id IN (SELECT project_id FROM agency_projects))
      )
      -- Capability matching (unchanged)
      AND (
        sd.required_capabilities = '{}'::jsonb
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(sd.required_capabilities -> 'all', '[]'::jsonb)
          ) req(cap)
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
  SET offer_status    = 'claimed',
      agent_identity  = p_agent_identity,
      agency_identity = p_agent_identity,   -- AC-4: explicit agency column
      claim_token     = v_new_token,
      claim_expires_at = v_expires,
      claimed_at      = now(),
      last_renewed_at = now(),
      offer_version   = sd.offer_version + 1
  WHERE sd.id = v_picked_id;

  RETURN QUERY
  SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
         sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.id = v_picked_id;
END;
$fn$;

COMMIT;
