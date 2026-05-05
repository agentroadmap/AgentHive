-- P844: Pool Identity Gating — agent_project_roles + pool_access_audit
--
-- Phase B gates DB pool access at the infrastructure layer using AgentContext
-- from AsyncLocalStorage (set by P843). Creates agent_project_roles table to
-- enforce project-scoped access for agent principals.
--
-- Depends on:
--   - P843 (Phase A): agentContextStorage in src/shared/identity/agent-context.ts
--   - control_identity.principal table (created by 002-identity.sql)
--   - workforce.agent and workforce.agent_project tables

-- ═══════════════════════════════════════════════════════════════════════════════
-- Agent-to-project role assignments (gating which projects an agent can query)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS control_identity.agent_project_roles (
  agent_principal_did  TEXT        NOT NULL
    REFERENCES control_identity.principal(did) ON DELETE CASCADE,
  project_slug         TEXT        NOT NULL,
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by           TEXT        NOT NULL,
  PRIMARY KEY (agent_principal_did, project_slug)
);

CREATE INDEX IF NOT EXISTS idx_agent_project_roles_did
  ON control_identity.agent_project_roles(agent_principal_did);

CREATE INDEX IF NOT EXISTS idx_agent_project_roles_slug
  ON control_identity.agent_project_roles(project_slug);

COMMENT ON TABLE control_identity.agent_project_roles IS
  'Agent-to-project role assignments. Enforces least-privilege project access for agent principals. '
  'Agents may only read their assigned projects. Kept in sync with workforce.agent_project via trigger.';

COMMENT ON COLUMN control_identity.agent_project_roles.agent_principal_did IS
  'Decentralised Identifier of the agent principal (FK to control_identity.principal.did).';

COMMENT ON COLUMN control_identity.agent_project_roles.project_slug IS
  'Project slug (e.g. agenthive, monkeyKing-audio). Agents with a row here may access the project DB.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Audit trail for all pool access decisions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS control_identity.pool_access_audit (
  id            BIGSERIAL   PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  principal_id  TEXT,
  project_slug  TEXT,
  result        TEXT        NOT NULL
    CHECK (result IN ('allowed', 'denied', 'bootstrap_passthrough')),
  call_site     TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pool_access_audit_ts
  ON control_identity.pool_access_audit(ts DESC);

CREATE INDEX IF NOT EXISTS idx_pool_access_audit_principal
  ON control_identity.pool_access_audit(principal_id);

CREATE INDEX IF NOT EXISTS idx_pool_access_audit_result
  ON control_identity.pool_access_audit(result, ts DESC);

COMMENT ON TABLE control_identity.pool_access_audit IS
  'Append-only audit trail for all pool access decisions. Records allowed, denied, and '
  'bootstrap_passthrough outcomes for debugging and compliance.';

COMMENT ON COLUMN control_identity.pool_access_audit.result IS
  'allowed = agent has project role, access granted; '
  'denied = agent lacks project role, access rejected; '
  'bootstrap_passthrough = non-agent principal (operator/agency), access allowed.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Bootstrap seed: populate agent_project_roles from workforce.agent_project
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO control_identity.agent_project_roles (agent_principal_did, project_slug, granted_by)
SELECT p.did, ap.project_id, 'bootstrap-seed'
FROM workforce.agent_project ap
JOIN workforce.agent a ON a.id = ap.agent_id
JOIN control_identity.principal p ON p.did = a.agent_identity
WHERE ap.ended_at IS NULL
  AND a.lifecycle_status = 'active'
  AND p.lifecycle_status = 'active'
ON CONFLICT (agent_principal_did, project_slug) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Trigger: sync agent_project_roles from workforce.agent_project mutations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION control_identity.sync_agent_project_role()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_did TEXT;
  v_project_slug TEXT;
BEGIN
  -- Resolve the agent's DID from workforce.agent via agent_identity
  SELECT p.did INTO v_did
  FROM workforce.agent a
  JOIN control_identity.principal p ON p.did = a.agent_identity
  WHERE a.id = COALESCE(NEW.agent_id, OLD.agent_id);

  -- Resolve project slug
  SELECT ap.project_id INTO v_project_slug
  FROM workforce.agent_project ap
  WHERE ap.id = COALESCE(NEW.id, OLD.id);

  -- NULL guard: if no matching principal exists, skip silently.
  -- This prevents silent security failures where an agent gets
  -- no role entry and appears denied by default (safe-fail), but
  -- the trigger should not error and must log the gap.
  IF v_did IS NULL THEN
    RAISE WARNING '[P844] sync_agent_project_role: no principal found for agent_id=%, skipping',
      COALESCE(NEW.agent_id, OLD.agent_id);
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_project_slug IS NULL THEN
    RAISE WARNING '[P844] sync_agent_project_role: no project_id found for agent_project.id=%, skipping',
      COALESCE(NEW.id, OLD.id);
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- INSERT or UPDATE with ended_at IS NULL (active assignment)
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.ended_at IS NULL) THEN
    INSERT INTO control_identity.agent_project_roles
      (agent_principal_did, project_slug, granted_by)
    VALUES (v_did, v_project_slug, 'workforce-sync')
    ON CONFLICT (agent_principal_did, project_slug) DO NOTHING;

  -- DELETE or UPDATE with ended_at IS NOT NULL (assignment ended)
  ELSIF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.ended_at IS NOT NULL) THEN
    DELETE FROM control_identity.agent_project_roles
    WHERE agent_principal_did = v_did
      AND project_slug = v_project_slug;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_agent_project_role ON workforce.agent_project;
CREATE TRIGGER trg_sync_agent_project_role
  AFTER INSERT OR UPDATE OR DELETE ON workforce.agent_project
  FOR EACH ROW EXECUTE FUNCTION control_identity.sync_agent_project_role();

COMMENT ON FUNCTION control_identity.sync_agent_project_role() IS
  'Keeps control_identity.agent_project_roles in sync with workforce.agent_project. '
  'Grants or revokes project access when agent-project assignments start or end.';
