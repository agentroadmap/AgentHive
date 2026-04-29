-- ============================================================
-- Migration 066 — P436: Control-plane schema reconciliation
-- Resolves all FK drift between canonical roadmap.project
-- and legacy roadmap_workforce.projects table.
-- Makes fn_claim_work_offer FAIL-CLOSED.
-- ============================================================
-- Idempotent: all steps use IF NOT EXISTS / DO NOTHING / OR REPLACE.
-- Run in a transaction; rolls back cleanly on any step failure.
-- Prerequisites: migrations 050 (roadmap.project) and 051 (project_id propagation).
-- ============================================================

BEGIN;

-- ── Step 1: Fix proposal.project_id FK ───────────────────────
-- Drop legacy FK → roadmap_workforce.projects(id)
-- Add canonical FK → roadmap.project(project_id)

ALTER TABLE roadmap_proposal.proposal
  DROP CONSTRAINT IF EXISTS proposal_project_id_fkey;

ALTER TABLE roadmap_proposal.proposal
  ADD CONSTRAINT proposal_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES roadmap.project(project_id)
  ON DELETE RESTRICT;

-- ── Step 2: Fix squad_dispatch.project_id FK ─────────────────

ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_project_id_fkey;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES roadmap.project(project_id)
  ON DELETE RESTRICT;

-- ── Step 3: Add FK on provider_registry.project_id ───────────
-- Column exists as BIGINT NULL since migration 041 but has no FK constraint.
-- Nullable preserved: NULL = all projects (global provider). Non-null = single-project scope.

ALTER TABLE roadmap_workforce.provider_registry
  ADD CONSTRAINT provider_registry_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES roadmap.project(project_id)
  ON DELETE RESTRICT
  NOT VALID;

-- Validate after backfill in step 5 (avoids full-table scan before backfill)

-- ── Step 4: Add project_id to gate_decision_log ──────────────

-- 4a. Add column to base table
ALTER TABLE roadmap_proposal.gate_decision_log
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

-- 4b. Backfill from proposal table (gate decisions reference proposals 1:1)
UPDATE roadmap_proposal.gate_decision_log gdl
SET project_id = p.project_id
FROM roadmap_proposal.proposal p
WHERE gdl.proposal_id = p.id
  AND gdl.project_id IS NULL;

-- 4c. Any remaining NULLs (proposals with no project_id) default to agenthive
UPDATE roadmap_proposal.gate_decision_log
SET project_id = 1
WHERE project_id IS NULL;

-- 4d. Set NOT NULL now that backfill is complete
ALTER TABLE roadmap_proposal.gate_decision_log
  ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE roadmap_proposal.gate_decision_log
  ALTER COLUMN project_id SET DEFAULT 1;

-- 4e. Add FK
ALTER TABLE roadmap_proposal.gate_decision_log
  ADD CONSTRAINT gate_decision_log_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES roadmap.project(project_id)
  ON DELETE RESTRICT;

-- 4f. Extend roadmap.gate_decision_log view to expose project_id.
-- CREATE OR REPLACE VIEW can add new columns only at the end (existing columns/order unchanged).
CREATE OR REPLACE VIEW roadmap.gate_decision_log AS
  SELECT
    id, proposal_id, from_state, to_state, maturity,
    gate, gate_level, decided_by, authority_agent, decision, rationale,
    ac_verification, dependency_check, design_review,
    challenges, blockers, signature_hash, created_at,
    project_id
  FROM roadmap_proposal.gate_decision_log;

-- ── Step 4g: Add project_id to run_log and context_window_log ─
-- Both tables are empty (0 rows) — safe to alter without backfill.

ALTER TABLE roadmap.run_log
  ADD COLUMN IF NOT EXISTS project_id BIGINT DEFAULT 1
  REFERENCES roadmap.project(project_id) ON DELETE RESTRICT;

ALTER TABLE roadmap_efficiency.context_window_log
  ADD COLUMN IF NOT EXISTS project_id BIGINT DEFAULT 1
  REFERENCES roadmap.project(project_id) ON DELETE RESTRICT;

-- Extend context_window_log view to expose project_id (added at end).
CREATE OR REPLACE VIEW roadmap.context_window_log AS
  SELECT
    id, agent_identity, proposal_id, model_name,
    input_tokens, output_tokens, total_tokens,
    context_limit, was_truncated, truncation_note,
    run_id, logged_at, provider,
    project_id
  FROM roadmap_efficiency.context_window_log;

-- ── Step 4h: Backfill NULL project_id in squad_dispatch ──────
-- 3430 rows have project_id IS NULL from pre-P482 inserts.
-- All active traffic is project 1 (agenthive); backfill to 1.
UPDATE roadmap_workforce.squad_dispatch
SET project_id = 1
WHERE project_id IS NULL;

-- ── Step 5: Backfill 6 grandfathered agencies ─────────────────
-- Agencies of type 'agency' with no provider_registry rows get
-- a scoped row for project_id=1 (agenthive). This is the prerequisite
-- for the FAIL-CLOSED fn_claim_work_offer update in Step 6.

INSERT INTO roadmap_workforce.provider_registry
  (agency_id, agency_identity, project_id, capabilities, status, is_active)
SELECT
  ar.id,
  ar.agent_identity,
  1,  -- agenthive project
  '[]'::jsonb,
  'active',
  true
FROM roadmap_workforce.agent_registry ar
WHERE ar.agent_type = 'agency'
  AND NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = ar.id
  )
ON CONFLICT DO NOTHING;

-- 5b. Now validate the provider_registry FK (deferred from Step 3)
ALTER TABLE roadmap_workforce.provider_registry
  VALIDATE CONSTRAINT provider_registry_project_id_fkey;

-- ── Step 6: Make fn_claim_work_offer FAIL-CLOSED ─────────────
-- Remove the UNION fallback that allowed agencies with no provider_registry
-- rows to claim all project dispatches. After Step 5, all agencies have
-- at least one provider_registry row, so the fallback is unreachable.
-- Agencies without an active provider_registry row now get zero candidates.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity    TEXT,
  p_required_capabilities JSONB    DEFAULT '{}'::JSONB,
  p_lease_ttl_seconds INT          DEFAULT 20,
  p_project_id        BIGINT       DEFAULT NULL
)
RETURNS TABLE(
  dispatch_id       BIGINT,
  proposal_id       BIGINT,
  squad_name        TEXT,
  dispatch_role     TEXT,
  claim_token       UUID,
  claim_expires_at  TIMESTAMPTZ,
  offer_version     INT,
  metadata          JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_picked_id BIGINT;
  v_new_token UUID       := gen_random_uuid();
  v_expires   TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_agency_id BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT ar.id INTO v_agency_id
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.agent_identity = p_agent_identity;

  WITH agent_caps AS (
    SELECT ac.capability
    FROM roadmap_workforce.agent_capability ac
    JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
    WHERE ar.agent_identity = p_agent_identity
  ),
  agency_projects AS (
    -- FAIL-CLOSED: only projects the agency has explicitly joined.
    -- Agencies with no active provider_registry row get zero matches.
    SELECT pr.project_id
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
  ),
  candidate AS (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.offer_status = 'open'
      AND (
        (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
        OR (p_project_id IS NULL  AND sd.project_id IN (SELECT project_id FROM agency_projects))
      )
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

-- ── Step 7: Post-migration validation ────────────────────────

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify no proposal rows orphaned from roadmap.project
  SELECT COUNT(*) INTO v_count
  FROM roadmap_proposal.proposal p
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap.project rp WHERE rp.project_id = p.project_id
  );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'P436 validation: % proposal rows orphaned from roadmap.project', v_count;
  END IF;

  -- Verify no squad_dispatch rows orphaned
  SELECT COUNT(*) INTO v_count
  FROM roadmap_workforce.squad_dispatch sd
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap.project rp WHERE rp.project_id = sd.project_id
  );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'P436 validation: % squad_dispatch rows orphaned from roadmap.project', v_count;
  END IF;

  -- Verify all agency-type agents now have at least one active provider_registry row
  SELECT COUNT(*) INTO v_count
  FROM roadmap_workforce.agent_registry ar
  WHERE ar.agent_type = 'agency'
    AND NOT EXISTS (
      SELECT 1 FROM roadmap_workforce.provider_registry pr
      WHERE pr.agency_id = ar.id AND pr.status = 'active'
    );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'P436 validation: % agency-type agents still have no active provider_registry row', v_count;
  END IF;

  -- Verify gate_decision_log backfill complete
  SELECT COUNT(*) INTO v_count
  FROM roadmap_proposal.gate_decision_log
  WHERE project_id IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'P436 validation: % gate_decision_log rows have NULL project_id after backfill', v_count;
  END IF;

  RAISE NOTICE 'P436 validation: all checks passed';
END $$;

COMMIT;
