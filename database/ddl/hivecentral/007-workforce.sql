-- P597: workforce schema — agent, skill, capability (hivecentral)
-- Tables : agent, skill, agent_skill, agent_project, skill_grant_log
-- Views  : v_agent_capabilities, v_project_coverage, v_skill_roster
-- Enum   : agent_type, agent_status, skill_lifecycle, proficiency_level, grant_action
-- Dep    : none (standalone; migration from roadmap_workforce.* → 056-workforce-from-roadmap.sql)
-- 2026-04-27

BEGIN;

-- ── Schema ────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS workforce;

-- ── Enum types ────────────────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE workforce.agent_type AS ENUM ('human', 'ai', 'hybrid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE workforce.agent_status AS ENUM ('active', 'inactive', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE workforce.skill_lifecycle AS ENUM ('active', 'deprecated', 'proposed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    -- Ordered: none < basic < intermediate < advanced < expert
    CREATE TYPE workforce.proficiency_level AS ENUM ('none', 'basic', 'intermediate', 'advanced', 'expert');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE workforce.grant_action AS ENUM ('grant', 'revoke', 'update', 'expire');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 1. workforce.agent — project-agnostic agent catalog ───────────────────────
-- Project assignment is via workforce.agent_project (join table), not here.
-- agent_identity is the stable cross-table handle (e.g. 'senior-backend').

CREATE TABLE IF NOT EXISTS workforce.agent (
    id             BIGINT                  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_identity TEXT                    NOT NULL UNIQUE,
    display_name   TEXT                    NOT NULL,
    agent_type     workforce.agent_type    NOT NULL DEFAULT 'ai',
    persona        TEXT,
    contact        TEXT,
    status         workforce.agent_status  NOT NULL DEFAULT 'active',
    metadata       JSONB                   NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ             NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_agent_identity
    ON workforce.agent (agent_identity);
CREATE INDEX IF NOT EXISTS idx_workforce_agent_type_status
    ON workforce.agent (agent_type, status)
    WHERE status = 'active';

COMMENT ON TABLE  workforce.agent IS
    'Project-agnostic agent catalog. Covers human, AI, and hybrid agents. Project membership tracked in workforce.agent_project.';
COMMENT ON COLUMN workforce.agent.agent_identity IS
    'Stable unique handle: senior-backend, skeptic-alpha, product-manager. Used as FK across all tables.';
COMMENT ON COLUMN workforce.agent.persona IS
    'Short persona description / system prompt summary. Informational; full prompt lives in routing layer.';
COMMENT ON COLUMN workforce.agent.metadata IS
    'Extension bag: {preferred_model, api_spec, spawn_policy, github_repo, ...}.';

-- ── 2. workforce.skill — global skill catalog ─────────────────────────────────

CREATE TABLE IF NOT EXISTS workforce.skill (
    id                 BIGINT                   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_name         TEXT                     NOT NULL UNIQUE,
    display_name       TEXT                     NOT NULL,
    description        TEXT,
    category           TEXT                     NOT NULL,
    lifecycle          workforce.skill_lifecycle NOT NULL DEFAULT 'active',
    successor_skill_id BIGINT                   REFERENCES workforce.skill(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ              NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ              NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_skill_category
    ON workforce.skill (category)
    WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS idx_workforce_skill_lifecycle
    ON workforce.skill (lifecycle);

COMMENT ON TABLE  workforce.skill IS
    'Global skill catalog. Skills can be granted, revoked, or deprecated. Deprecated skills point to a successor.';
COMMENT ON COLUMN workforce.skill.skill_name IS
    'Slug form used in queries and API calls: code-review, architecture-review, security-audit.';
COMMENT ON COLUMN workforce.skill.successor_skill_id IS
    'When lifecycle=deprecated, points to the recommended replacement skill.';

-- ── 3. workforce.agent_skill — capability matrix ──────────────────────────────
-- Composite PK (agent_id, skill_id). One active row per agent×skill.
-- Full history is in workforce.skill_grant_log (auto-populated by trigger).

CREATE TABLE IF NOT EXISTS workforce.agent_skill (
    agent_id    BIGINT                      NOT NULL REFERENCES workforce.agent(id) ON DELETE CASCADE,
    skill_id    BIGINT                      NOT NULL REFERENCES workforce.skill(id) ON DELETE CASCADE,
    proficiency workforce.proficiency_level NOT NULL DEFAULT 'basic',
    granted_by  TEXT                        NOT NULL,
    granted_at  TIMESTAMPTZ                 NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    notes       TEXT,
    PRIMARY KEY (agent_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_workforce_agent_skill_skill_prof
    ON workforce.agent_skill (skill_id, proficiency);
CREATE INDEX IF NOT EXISTS idx_workforce_agent_skill_expires
    ON workforce.agent_skill (expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE  workforce.agent_skill IS
    'Agent×Skill capability matrix. Composite PK (agent_id, skill_id). One active row per combination; history in skill_grant_log.';
COMMENT ON COLUMN workforce.agent_skill.proficiency IS
    'Ordered enum: none < basic < intermediate < advanced < expert. Drives skill-based dispatch routing.';
COMMENT ON COLUMN workforce.agent_skill.granted_by IS
    'agent_identity of the granting agent, or "system" for seed/bootstrap grants.';
COMMENT ON COLUMN workforce.agent_skill.expires_at IS
    'NULL = permanent. Non-NULL = certification with expiry. Expired rows excluded from v_agent_capabilities.';

-- ── 4. workforce.agent_project — cross-project assignment ────────────────────
-- ended_at=NULL means currently assigned. Historical rows are retained.

CREATE TABLE IF NOT EXISTS workforce.agent_project (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id    BIGINT      NOT NULL REFERENCES workforce.agent(id) ON DELETE CASCADE,
    project_id  TEXT        NOT NULL,
    role        TEXT        NOT NULL DEFAULT 'contributor'
                            CHECK (role IN ('contributor', 'reviewer', 'gatekeeper', 'observer', 'owner')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,
    notes       TEXT,
    CONSTRAINT agent_project_lifecycle_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_project_unique_active
    ON workforce.agent_project (agent_id, project_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workforce_agent_project_active
    ON workforce.agent_project (agent_id, project_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workforce_agent_project_by_project
    ON workforce.agent_project (project_id)
    WHERE ended_at IS NULL;

COMMENT ON TABLE  workforce.agent_project IS
    'Cross-project agent assignment. ended_at=NULL = currently assigned. Historical rows retained for audit.';
COMMENT ON COLUMN workforce.agent_project.project_id IS
    'Tenant project slug (agenthive, monkeyKing-audio, …). Logical FK to project registry (P429/P495).';
COMMENT ON COLUMN workforce.agent_project.role IS
    'Role in project: contributor, reviewer, gatekeeper, observer, owner.';

-- ── 5. workforce.skill_grant_log — append-only audit trail ───────────────────

CREATE TABLE IF NOT EXISTS workforce.skill_grant_log (
    id              BIGINT                      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id        BIGINT                      NOT NULL REFERENCES workforce.agent(id),
    skill_id        BIGINT                      NOT NULL REFERENCES workforce.skill(id),
    action          workforce.grant_action      NOT NULL,
    old_proficiency workforce.proficiency_level,
    new_proficiency workforce.proficiency_level,
    acted_by        TEXT                        NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ                 NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_grant_log_agent
    ON workforce.skill_grant_log (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workforce_grant_log_skill
    ON workforce.skill_grant_log (skill_id, created_at DESC);

COMMENT ON TABLE  workforce.skill_grant_log IS
    'Append-only audit trail for all skill grant/revoke/update/expire events. Auto-populated by trg_agent_skill_audit.';

-- ── Triggers: updated_at ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION workforce.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_workforce_agent_updated_at
        BEFORE UPDATE ON workforce.agent
        FOR EACH ROW EXECUTE FUNCTION workforce.fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_workforce_skill_updated_at
        BEFORE UPDATE ON workforce.skill
        FOR EACH ROW EXECUTE FUNCTION workforce.fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Trigger: deny mutations on append-only audit log ─────────────────────────

CREATE OR REPLACE FUNCTION workforce.fn_deny_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'mutation forbidden: % is append-only (op=%, table=%)',
        TG_TABLE_NAME, TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_skill_grant_log_immutable
        BEFORE UPDATE OR DELETE ON workforce.skill_grant_log
        FOR EACH ROW EXECUTE FUNCTION workforce.fn_deny_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

REVOKE UPDATE, DELETE ON workforce.skill_grant_log FROM PUBLIC;

-- ── Trigger: auto-populate audit log from agent_skill mutations ───────────────

CREATE OR REPLACE FUNCTION workforce.fn_audit_agent_skill()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO workforce.skill_grant_log
            (agent_id, skill_id, action, new_proficiency, acted_by)
        VALUES
            (NEW.agent_id, NEW.skill_id, 'grant', NEW.proficiency, NEW.granted_by);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO workforce.skill_grant_log
            (agent_id, skill_id, action, old_proficiency, new_proficiency, acted_by)
        VALUES
            (NEW.agent_id, NEW.skill_id, 'update', OLD.proficiency, NEW.proficiency, NEW.granted_by);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO workforce.skill_grant_log
            (agent_id, skill_id, action, old_proficiency, acted_by)
        VALUES
            (OLD.agent_id, OLD.skill_id, 'revoke', OLD.proficiency, 'system');
        RETURN OLD;
    END IF;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_agent_skill_audit
        AFTER INSERT OR UPDATE OR DELETE ON workforce.agent_skill
        FOR EACH ROW EXECUTE FUNCTION workforce.fn_audit_agent_skill();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Views (AC-4 capability queries) ──────────────────────────────────────────

-- AC-4a: Find agents by skill + required proficiency (skill-based dispatch)
CREATE OR REPLACE VIEW workforce.v_agent_capabilities AS
SELECT
    a.agent_identity,
    a.display_name,
    a.agent_type,
    a.status,
    s.skill_name,
    s.category,
    ags.proficiency,
    ags.granted_at,
    ags.expires_at,
    (ags.expires_at IS NOT NULL AND ags.expires_at < now()) AS is_expired
FROM  workforce.agent_skill ags
JOIN  workforce.agent        a ON a.id = ags.agent_id
JOIN  workforce.skill         s ON s.id = ags.skill_id
WHERE a.status = 'active';

COMMENT ON VIEW workforce.v_agent_capabilities IS
    'AC-4a: Active agents with their skill matrix. Filter on skill_name + proficiency for dispatch. Includes is_expired flag.';

-- AC-4b: Audit project skill coverage (active assignments with non-expired grants)
CREATE OR REPLACE VIEW workforce.v_project_coverage AS
SELECT
    ap.project_id,
    a.agent_identity,
    a.display_name,
    a.status     AS agent_status,
    s.skill_name,
    s.category,
    ags.proficiency,
    ap.role,
    ap.started_at
FROM  workforce.agent_project ap
JOIN  workforce.agent          a   ON a.id   = ap.agent_id
JOIN  workforce.agent_skill    ags ON ags.agent_id = ap.agent_id
JOIN  workforce.skill           s  ON s.id   = ags.skill_id
WHERE ap.ended_at IS NULL
  AND a.status = 'active'
  AND (ags.expires_at IS NULL OR ags.expires_at > now());

COMMENT ON VIEW workforce.v_project_coverage IS
    'AC-4b: Per-project skill coverage — active assignments × non-expired skill grants.';

-- AC-4c: Full grant history per agent (from audit log)
CREATE OR REPLACE VIEW workforce.v_skill_roster AS
SELECT
    a.agent_identity,
    s.skill_name,
    s.category,
    sgl.action,
    sgl.old_proficiency,
    sgl.new_proficiency,
    sgl.acted_by,
    sgl.notes,
    sgl.created_at
FROM  workforce.skill_grant_log sgl
JOIN  workforce.agent           a ON a.id = sgl.agent_id
JOIN  workforce.skill            s ON s.id = sgl.skill_id
ORDER BY sgl.created_at DESC;

COMMENT ON VIEW workforce.v_skill_roster IS
    'AC-4c: Full skill grant/revoke history per agent. Reads from append-only audit log.';

-- ── Seed: AgentHive core agent personas ──────────────────────────────────────

INSERT INTO workforce.agent (agent_identity, display_name, agent_type, persona, status) VALUES
    ('senior-backend',      'Senior Backend Engineer',    'ai',    'Expert backend engineer: Laravel/PostgreSQL/TypeScript. Implements and reviews server-side code.',              'active'),
    ('skeptic-alpha',       'Skeptic Alpha (Gate Agent)', 'ai',    'Gate reviewer: RFC coherence, AC measurability, architectural fit. Holds unless criteria are met.',             'active'),
    ('product-manager',     'Product Manager',            'ai',    'Proposal authoring, AC design, backlog prioritisation, stakeholder communication.',                             'active'),
    ('agency-orchestrator', 'Agency Orchestrator',        'ai',    'Workflow orchestrator: spawns cubics, monitors pipeline, mediates contention.',                                 'active'),
    ('worker-enhancer',     'Worker Enhancer',            'ai',    'DRAFT-phase enhancer: closes gate gaps, adds evidence, converts ACs to testable state.',                        'active')
ON CONFLICT (agent_identity) DO NOTHING;

-- ── Seed: Core skill catalog ──────────────────────────────────────────────────

INSERT INTO workforce.skill (skill_name, display_name, description, category, lifecycle) VALUES
    ('backend-development',    'Backend Development',     'Server-side code: APIs, DB schema, migrations, services',                           'engineering', 'active'),
    ('code-review',            'Code Review',             'Structured review for correctness, security, and maintainability',                   'engineering', 'active'),
    ('architecture-review',    'Architecture Review',     'System design review: scalability, coupling, data model integrity',                  'engineering', 'active'),
    ('sql-schema-design',      'SQL Schema Design',       'Relational schema design, normalization, index strategy, migration planning',        'engineering', 'active'),
    ('gate-review',            'Gate Review',             'RFC gate assessment: coherence, AC measurability, architectural fit',               'governance',  'active'),
    ('proposal-authoring',     'Proposal Authoring',      'Writing RFCs with motivation, design, acceptance criteria, and dependency mapping', 'governance',  'active'),
    ('security-audit',         'Security Audit',          'OWASP, threat modeling, credential and injection vulnerability review',             'security',    'active'),
    ('workflow-orchestration', 'Workflow Orchestration',  'Cubic dispatch, agent lifecycle, pipeline health monitoring',                       'platform',    'active'),
    ('product-strategy',       'Product Strategy',        'Roadmap design, backlog prioritization, stakeholder alignment',                     'product',     'active'),
    ('test-design',            'Test Design',             'AC design, integration test planning, coverage analysis',                           'engineering', 'active')
ON CONFLICT (skill_name) DO NOTHING;

-- ── Seed: Agent×Skill capability grants ──────────────────────────────────────

INSERT INTO workforce.agent_skill (agent_id, skill_id, proficiency, granted_by)
SELECT a.id, s.id, v.prof::workforce.proficiency_level, 'system'
FROM (VALUES
    ('senior-backend',      'backend-development',    'expert'),
    ('senior-backend',      'code-review',            'advanced'),
    ('senior-backend',      'sql-schema-design',      'expert'),
    ('senior-backend',      'test-design',            'intermediate'),
    ('skeptic-alpha',       'gate-review',            'expert'),
    ('skeptic-alpha',       'architecture-review',    'advanced'),
    ('skeptic-alpha',       'security-audit',         'intermediate'),
    ('product-manager',     'proposal-authoring',     'expert'),
    ('product-manager',     'product-strategy',       'expert'),
    ('product-manager',     'gate-review',            'basic'),
    ('agency-orchestrator', 'workflow-orchestration', 'expert'),
    ('agency-orchestrator', 'gate-review',            'basic'),
    ('worker-enhancer',     'proposal-authoring',     'advanced'),
    ('worker-enhancer',     'gate-review',            'intermediate')
) AS v(ident, skill_name, prof)
JOIN workforce.agent a ON a.agent_identity = v.ident
JOIN workforce.skill  s ON s.skill_name    = v.skill_name
ON CONFLICT (agent_id, skill_id) DO NOTHING;

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA workforce TO xiaomi;

GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.agent         TO xiaomi;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.skill         TO xiaomi;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.agent_skill   TO xiaomi;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.agent_project TO xiaomi;
GRANT SELECT, INSERT                 ON workforce.skill_grant_log TO xiaomi;

GRANT SELECT ON workforce.v_agent_capabilities TO xiaomi;
GRANT SELECT ON workforce.v_project_coverage   TO xiaomi;
GRANT SELECT ON workforce.v_skill_roster       TO xiaomi;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA workforce TO xiaomi;

COMMIT;
