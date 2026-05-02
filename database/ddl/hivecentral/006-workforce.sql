-- ============================================================
-- P597 — hiveCentral.workforce schema
-- Cross-project agent profiles, skill catalog, agent x skill
-- capability matrix with proficiency, project assignments,
-- append-only skill grant audit log.
-- ============================================================
-- Target DB: hiveCentral
-- Owner: agenthive_admin
-- Roles granted (read): agenthive_orchestrator, agenthive_observability, agenthive_agency
-- Roles granted (write subset on agent_skill / skill_grant_log): agenthive_orchestrator
-- ============================================================

CREATE SCHEMA IF NOT EXISTS workforce;

COMMENT ON SCHEMA workforce IS
  'Persistent agent profiles, skill catalog, and capability matrix. Survives across '
  'projects and runtime sessions. Replaces transient roadmap_workforce.* for catalog '
  'concerns; runtime claim/lease state remains in roadmap_workforce until P429 lands.';

-- ============================================================
-- Enums
-- ============================================================
CREATE TYPE workforce.agent_kind        AS ENUM ('human', 'ai', 'hybrid');
CREATE TYPE workforce.agent_status      AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE workforce.skill_lifecycle   AS ENUM ('proposed', 'active', 'deprecated');
CREATE TYPE workforce.proficiency_level AS ENUM ('none', 'basic', 'intermediate', 'advanced', 'expert');
CREATE TYPE workforce.skill_grant_action AS ENUM ('grant', 'revoke', 'update', 'expire');

-- ============================================================
-- workforce.agent — persistent agent profile
-- ============================================================
CREATE TABLE workforce.agent (
  id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_identity    TEXT         NOT NULL UNIQUE,        -- stable handle: senior-backend, skeptic-alpha
  display_name      TEXT         NOT NULL,
  agent_type        workforce.agent_kind   NOT NULL,
  persona           TEXT,                                -- system-prompt summary
  contact           TEXT,                                -- notification endpoint
  status            workforce.agent_status NOT NULL DEFAULT 'active',
  metadata          JSONB        NOT NULL DEFAULT '{}',  -- preferred_model, api_spec, spawn_policy, etc.
  -- Catalog hygiene:
  owner_did         TEXT         NOT NULL,
  lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at     TIMESTAMPTZ,
  retire_after      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX agent_active           ON workforce.agent (agent_identity) WHERE status = 'active';
CREATE INDEX agent_lifecycle_active ON workforce.agent (id)             WHERE lifecycle_status = 'active';

COMMENT ON TABLE workforce.agent IS
  'Persistent agent catalog. Identity is stable across projects and runtime restarts. '
  'Runtime presence/lease state lives in roadmap_workforce.agent_registry until P429.';

-- ============================================================
-- workforce.skill — global skill catalog
-- ============================================================
CREATE TABLE workforce.skill (
  id                  BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  skill_name          TEXT         NOT NULL UNIQUE,                -- slug: code-review, gate-review
  display_name        TEXT         NOT NULL,
  description         TEXT,
  category            TEXT         NOT NULL                        -- engineering, governance, security, platform, product
                                  CHECK (category IN ('engineering','governance','security','platform','product','operations')),
  lifecycle           workforce.skill_lifecycle NOT NULL DEFAULT 'active',
  successor_skill_id  BIGINT       REFERENCES workforce.skill (id) ON DELETE RESTRICT,
  -- Catalog hygiene:
  owner_did           TEXT         NOT NULL,
  lifecycle_status    TEXT         NOT NULL DEFAULT 'active'
                                  CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at       TIMESTAMPTZ,
  retire_after        TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Deprecated skills must point to a successor (so callers can migrate).
  CONSTRAINT skill_successor_when_deprecated
    CHECK (lifecycle <> 'deprecated' OR successor_skill_id IS NOT NULL)
);

CREATE INDEX skill_active ON workforce.skill (skill_name) WHERE lifecycle = 'active';

COMMENT ON TABLE workforce.skill IS
  'Global skill catalog. Skills are slugs (e.g. code-review). Deprecated skills must '
  'name a successor so dispatch can transparently re-point.';

-- ============================================================
-- workforce.agent_skill — capability matrix
-- ============================================================
CREATE TABLE workforce.agent_skill (
  agent_id      BIGINT       NOT NULL REFERENCES workforce.agent (id) ON DELETE CASCADE,
  skill_id      BIGINT       NOT NULL REFERENCES workforce.skill (id) ON DELETE RESTRICT,
  proficiency   workforce.proficiency_level NOT NULL DEFAULT 'basic',
  granted_by    TEXT         NOT NULL,                     -- agent_identity or 'system'
  granted_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,                               -- NULL = permanent
  notes         TEXT,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE INDEX agent_skill_skill ON workforce.agent_skill (skill_id, proficiency);
CREATE INDEX agent_skill_agent ON workforce.agent_skill (agent_id, proficiency);

COMMENT ON TABLE workforce.agent_skill IS
  'Capability matrix. Proficiency is an ordered enum (none < basic < intermediate < '
  'advanced < expert). Dispatch routing compares with >=. Mutations auto-write to '
  'workforce.skill_grant_log via trigger trg_agent_skill_audit.';

-- ============================================================
-- workforce.agent_project — project membership (lifecycle)
-- ============================================================
CREATE TABLE workforce.agent_project (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id        BIGINT       NOT NULL REFERENCES workforce.agent (id) ON DELETE CASCADE,
  project_id      TEXT         NOT NULL,                   -- tenant slug; logical FK until P429
  role            TEXT         NOT NULL
                              CHECK (role IN ('contributor','reviewer','gatekeeper','observer','owner')),
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,                             -- NULL = currently active
  notes           TEXT,
  CONSTRAINT agent_project_lifecycle_chk
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- An agent can hold AT MOST ONE active membership per project at any time.
-- Past memberships (ended_at IS NOT NULL) are unconstrained for audit.
CREATE UNIQUE INDEX agent_project_unique_active
  ON workforce.agent_project (agent_id, project_id)
  WHERE ended_at IS NULL;

CREATE INDEX agent_project_active_by_project ON workforce.agent_project (project_id) WHERE ended_at IS NULL;
CREATE INDEX agent_project_active_by_agent   ON workforce.agent_project (agent_id)   WHERE ended_at IS NULL;

COMMENT ON TABLE workforce.agent_project IS
  'Agent x project membership with role and lifecycle. Partial unique index '
  '(agent_id, project_id) WHERE ended_at IS NULL prevents dual-active assignment.';

-- ============================================================
-- workforce.skill_grant_log — append-only audit trail
-- ============================================================
CREATE TABLE workforce.skill_grant_log (
  id                BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id          BIGINT       NOT NULL REFERENCES workforce.agent (id) ON DELETE RESTRICT,
  skill_id          BIGINT       NOT NULL REFERENCES workforce.skill (id) ON DELETE RESTRICT,
  action            workforce.skill_grant_action NOT NULL,
  old_proficiency   workforce.proficiency_level,           -- NULL on grant
  new_proficiency   workforce.proficiency_level,           -- NULL on revoke / expire
  acted_by          TEXT         NOT NULL,                  -- agent_identity
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX skill_grant_log_agent ON workforce.skill_grant_log (agent_id, created_at DESC);
CREATE INDEX skill_grant_log_skill ON workforce.skill_grant_log (skill_id, created_at DESC);

-- Append-only enforcement: deny UPDATE/DELETE at the SQL level.
REVOKE UPDATE, DELETE ON workforce.skill_grant_log FROM PUBLIC;

CREATE OR REPLACE FUNCTION workforce.deny_skill_grant_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workforce.skill_grant_log is append-only (op=%)', TG_OP;
END;
$$;

CREATE TRIGGER skill_grant_log_no_update
  BEFORE UPDATE ON workforce.skill_grant_log
  FOR EACH ROW EXECUTE FUNCTION workforce.deny_skill_grant_log_mutation();

CREATE TRIGGER skill_grant_log_no_delete
  BEFORE DELETE ON workforce.skill_grant_log
  FOR EACH ROW EXECUTE FUNCTION workforce.deny_skill_grant_log_mutation();

COMMENT ON TABLE workforce.skill_grant_log IS
  'Append-only audit of all agent_skill mutations. Written automatically by '
  'trg_agent_skill_audit; UPDATE and DELETE are blocked by trigger and revoke.';

-- ============================================================
-- Trigger: auto-write audit row on every agent_skill mutation
-- ============================================================
CREATE OR REPLACE FUNCTION workforce.audit_agent_skill_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_action workforce.skill_grant_action;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'grant';
    INSERT INTO workforce.skill_grant_log (agent_id, skill_id, action, old_proficiency, new_proficiency, acted_by, notes)
    VALUES (NEW.agent_id, NEW.skill_id, v_action, NULL, NEW.proficiency, NEW.granted_by, NEW.notes);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    INSERT INTO workforce.skill_grant_log (agent_id, skill_id, action, old_proficiency, new_proficiency, acted_by, notes)
    VALUES (NEW.agent_id, NEW.skill_id, v_action, OLD.proficiency, NEW.proficiency, NEW.granted_by, NEW.notes);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'revoke';
    INSERT INTO workforce.skill_grant_log (agent_id, skill_id, action, old_proficiency, new_proficiency, acted_by, notes)
    VALUES (OLD.agent_id, OLD.skill_id, v_action, OLD.proficiency, NULL, OLD.granted_by, OLD.notes);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_agent_skill_audit
  AFTER INSERT OR UPDATE OR DELETE ON workforce.agent_skill
  FOR EACH ROW EXECUTE FUNCTION workforce.audit_agent_skill_change();

-- ============================================================
-- Trigger: maintain updated_at on agent / skill
-- ============================================================
CREATE OR REPLACE FUNCTION workforce.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_touch_updated_at
  BEFORE UPDATE ON workforce.agent
  FOR EACH ROW EXECUTE FUNCTION workforce.touch_updated_at();

CREATE TRIGGER skill_touch_updated_at
  BEFORE UPDATE ON workforce.skill
  FOR EACH ROW EXECUTE FUNCTION workforce.touch_updated_at();

-- ============================================================
-- Views
-- ============================================================

-- v_agent_capabilities — active agents with skill matrix; filter by skill_name+proficiency for dispatch
CREATE OR REPLACE VIEW workforce.v_agent_capabilities AS
SELECT
  a.id              AS agent_id,
  a.agent_identity,
  a.display_name,
  a.agent_type,
  a.status          AS agent_status,
  s.id              AS skill_id,
  s.skill_name,
  s.category,
  s.lifecycle       AS skill_lifecycle,
  ask.proficiency,
  ask.granted_by,
  ask.granted_at,
  ask.expires_at,
  (ask.expires_at IS NOT NULL AND ask.expires_at <= now()) AS is_expired
FROM workforce.agent a
JOIN workforce.agent_skill ask ON ask.agent_id = a.id
JOIN workforce.skill s         ON s.id = ask.skill_id
WHERE a.status = 'active'
  AND a.lifecycle_status = 'active';

COMMENT ON VIEW workforce.v_agent_capabilities IS
  'Dispatch routing view: filter by skill_name and proficiency >= required, exclude is_expired.';

-- v_project_coverage — per-project skill coverage (active assignments x non-expired grants)
CREATE OR REPLACE VIEW workforce.v_project_coverage AS
SELECT
  ap.project_id,
  a.agent_identity,
  ap.role,
  s.skill_name,
  s.category,
  ask.proficiency,
  ask.granted_at,
  ask.expires_at
FROM workforce.agent_project ap
JOIN workforce.agent a         ON a.id = ap.agent_id
JOIN workforce.agent_skill ask ON ask.agent_id = a.id
JOIN workforce.skill s         ON s.id = ask.skill_id
WHERE ap.ended_at IS NULL
  AND a.status = 'active'
  AND (ask.expires_at IS NULL OR ask.expires_at > now());

COMMENT ON VIEW workforce.v_project_coverage IS
  'Per-project active skill coverage. Joins active agent_project memberships to '
  'non-expired agent_skill rows.';

-- v_skill_roster — full grant/revoke history per agent from audit log
CREATE OR REPLACE VIEW workforce.v_skill_roster AS
SELECT
  a.agent_identity,
  s.skill_name,
  sgl.action,
  sgl.old_proficiency,
  sgl.new_proficiency,
  sgl.acted_by,
  sgl.notes,
  sgl.created_at
FROM workforce.skill_grant_log sgl
JOIN workforce.agent a ON a.id = sgl.agent_id
JOIN workforce.skill s ON s.id = sgl.skill_id;

COMMENT ON VIEW workforce.v_skill_roster IS
  'Full skill grant/revoke/update/expire history per agent. Source: skill_grant_log.';

-- ============================================================
-- workforce.agent_trust — per-project authorization grants
-- ============================================================
-- Determines whether dispatch may assign work to this agent within
-- a given project scope. Global grants (project_id IS NULL) apply
-- across all projects. Project-scoped grants are additive.
-- Scope invariant: global ↔ project_id IS NULL; project ↔ NOT NULL.
CREATE TABLE workforce.agent_trust (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id         BIGINT       NOT NULL REFERENCES workforce.agent (id) ON DELETE CASCADE,
  scope            TEXT         NOT NULL DEFAULT 'project'
                               CHECK (scope IN ('global','project')),
  project_id       TEXT,                                   -- tenant slug; NULL when scope='global'
  trust_level      TEXT         NOT NULL
                               CHECK (trust_level IN ('observer','contributor','reviewer','gatekeeper','owner')),
  granted_by       TEXT         NOT NULL,                  -- agent_identity or 'system'
  granted_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,                            -- NULL = permanent
  revoked_at       TIMESTAMPTZ,
  revoked_by       TEXT,
  notes            TEXT,
  -- Catalog hygiene:
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Scope invariant
  CONSTRAINT agent_trust_scope_chk
    CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL)),
  -- Revocation must name who revoked
  CONSTRAINT agent_trust_revoke_chk
    CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL)
);

-- One active grant per (agent, scope=global) and per (agent, project_id, scope=project)
CREATE UNIQUE INDEX agent_trust_active_global
  ON workforce.agent_trust (agent_id)
  WHERE scope = 'global' AND revoked_at IS NULL AND lifecycle_status = 'active';

CREATE UNIQUE INDEX agent_trust_active_project
  ON workforce.agent_trust (agent_id, project_id)
  WHERE scope = 'project' AND revoked_at IS NULL AND lifecycle_status = 'active';

CREATE INDEX agent_trust_project ON workforce.agent_trust (project_id) WHERE revoked_at IS NULL;
CREATE INDEX agent_trust_agent   ON workforce.agent_trust (agent_id, trust_level);

CREATE OR REPLACE TRIGGER agent_trust_touch_updated_at
  BEFORE UPDATE ON workforce.agent_trust
  FOR EACH ROW EXECUTE FUNCTION workforce.touch_updated_at();

COMMENT ON TABLE workforce.agent_trust IS
  'Authorization grants controlling whether an agent may operate within a project '
  'scope. scope=global grants apply platform-wide; scope=project grants are '
  'project-specific. Dispatch checks for an active (non-revoked, non-expired) row '
  'with the required trust_level before assigning work. One active grant per scope '
  'target enforced by partial unique indexes.';

COMMENT ON COLUMN workforce.agent_trust.trust_level IS
  'observer = read-only; contributor = work on proposals; reviewer = peer review; '
  'gatekeeper = gate decisions; owner = full project control.';

-- ============================================================
-- Grants (per CONVENTIONS §6 / hivecentral README)
-- ============================================================
GRANT USAGE ON SCHEMA workforce TO
  agenthive_orchestrator,
  agenthive_observability,
  agenthive_agency;

GRANT SELECT ON ALL TABLES    IN SCHEMA workforce TO agenthive_orchestrator, agenthive_observability, agenthive_agency;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA workforce TO agenthive_orchestrator, agenthive_observability, agenthive_agency;

-- Orchestrator may write capability records (post-verification) and project memberships.
GRANT INSERT, UPDATE, DELETE ON workforce.agent_skill   TO agenthive_orchestrator;
GRANT INSERT, UPDATE         ON workforce.agent_project TO agenthive_orchestrator;
GRANT INSERT                 ON workforce.skill_grant_log TO agenthive_orchestrator;
GRANT INSERT, UPDATE         ON workforce.agent_trust   TO agenthive_orchestrator;
