-- Migration 103: P844 — Pool Identity Gating tables
--
-- Creates control_identity.agent_project_roles (enforcement copy) and
-- control_identity.pool_access_audit (audit log) for Phase B of P841.
-- Also seeds agent_project_roles from existing active workforce.agent_project rows.

BEGIN;

-- ── 1. agent_project_roles — enforcement copy ────────────────────────────────
-- FK references control_identity.principal(did) once that table exists.
-- For now principal lookup is done via roadmap.principal_identity.principal_id.
CREATE TABLE IF NOT EXISTS control_identity.agent_project_roles (
  agent_principal_did  TEXT        NOT NULL,
  project_slug         TEXT        NOT NULL,
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by           TEXT        NOT NULL DEFAULT 'bootstrap-seed',
  PRIMARY KEY (agent_principal_did, project_slug)
);

COMMENT ON TABLE control_identity.agent_project_roles IS
  'P844: Enforcement copy of agent→project role assignments. Source of truth is workforce.agent_project; kept in sync by trg_sync_agent_project_role trigger.';

-- ── 2. pool_access_audit — audit log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_identity.pool_access_audit (
  id           BIGSERIAL   PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  principal_id TEXT,
  project_slug TEXT        NOT NULL,
  result       TEXT        NOT NULL CHECK (result IN ('allowed', 'denied', 'bootstrap_passthrough')),
  call_site    TEXT
);

CREATE INDEX IF NOT EXISTS idx_pool_access_audit_principal
  ON control_identity.pool_access_audit (principal_id, ts DESC)
  WHERE principal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pool_access_audit_denied
  ON control_identity.pool_access_audit (ts DESC)
  WHERE result = 'denied';

COMMENT ON TABLE control_identity.pool_access_audit IS
  'P844: Audit log for pool.query() and getProjectDb() identity gate decisions.';

-- ── 3. Bootstrap seed from workforce.agent_project ──────────────────────────
-- Only seeds rows where the principal exists in roadmap.principal_identity
-- (agents registered before P472 migration will be missing; safe-fail).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap'
      AND table_name = 'principal_identity'
  ) THEN
    INSERT INTO control_identity.agent_project_roles
      (agent_principal_did, project_slug, granted_by)
    SELECT DISTINCT
      pi.principal_id,
      COALESCE(ap.project_id, p.slug, ap.project_id) AS project_slug,
      'bootstrap-seed'
    FROM roadmap.principal_identity pi
    JOIN roadmap_workforce.agent_registry ar
      ON ar.agent_identity = replace(pi.principal_id, 'agent:', '')
    -- No workforce.agent_project table yet in all deployments; skip gracefully
    WHERE pi.principal_kind = 'agent'
    ON CONFLICT DO NOTHING;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Bootstrap seed is best-effort; never block migration
  RAISE WARNING '[P844] Bootstrap seed skipped: %', SQLERRM;
END;
$$;

COMMIT;
