-- P748: agent_role_profile — queue-role profile table keyed by workflow stage + maturity
-- Centralises the three legacy literal maps:
--   STAGE_DISPATCH_ROLES  (src/core/pipeline/pipeline-cron.ts)
--   JOB_ROLES             (scripts/orchestrator.ts)
--   GATE_ROLES            (scripts/orchestrator.ts)
-- into a single DB table so adding a new (workflow, stage, maturity) row is a one-line
-- INSERT rather than a three-file edit.

BEGIN;

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.agent_role_profile (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope                   TEXT    NOT NULL CHECK (scope IN ('global', 'project')),
    project_id              BIGINT  NULL REFERENCES roadmap.project(project_id),
    workflow_template_id    BIGINT  NOT NULL REFERENCES roadmap.workflow_templates(id),
    stage                   TEXT    NOT NULL,
    maturity                TEXT    NOT NULL CHECK (maturity IN ('new', 'active', 'mature', 'obsolete')),
    role                    TEXT    NOT NULL,
    required_capabilities   TEXT[]  NOT NULL DEFAULT '{}',
    allowed_route_providers TEXT[]  NULL,
    forbidden_route_providers TEXT[] NULL,
    prompt_template         JSONB   NULL,
    priority                INTEGER NOT NULL DEFAULT 100,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- NULL-safe uniqueness: two global rows with the same (template, stage, maturity, role)
    -- must be rejected even though project_id IS NULL on both.
    CONSTRAINT agent_role_profile_unique
        UNIQUE NULLS NOT DISTINCT (scope, project_id, workflow_template_id, stage, maturity, role)
);

COMMENT ON TABLE roadmap.agent_role_profile IS
    'Queue-role dispatch profiles keyed by (workflow_template, stage, maturity). '
    'Global rows (scope=global, project_id=NULL) are defaults; project rows override them.';

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION roadmap.set_agent_role_profile_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_agent_role_profile_updated_at ON roadmap.agent_role_profile;
CREATE TRIGGER trg_agent_role_profile_updated_at
    BEFORE UPDATE ON roadmap.agent_role_profile
    FOR EACH ROW EXECUTE FUNCTION roadmap.set_agent_role_profile_updated_at();

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_agent_role_profile_lookup
    ON roadmap.agent_role_profile (workflow_template_id, stage, maturity, scope);

CREATE INDEX IF NOT EXISTS idx_agent_role_profile_project
    ON roadmap.agent_role_profile (project_id)
    WHERE project_id IS NOT NULL;

-- ─── Seed: Standard RFC (workflow_template_id = 14) ───────────────────────────
-- new  = proposal just entered stage — dispatch prep/build agents
-- mature = proposal ready for gate decision — dispatch reviewer/gate agents

INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    -- DRAFT / new — enrichment agents
    ('global', NULL, 14, 'DRAFT', 'new',    'architect',    ARRAY['design','system-design'],      10),
    ('global', NULL, 14, 'DRAFT', 'new',    'researcher',   ARRAY['research'],                     20),
    -- DRAFT / mature — spec gate (D1)
    ('global', NULL, 14, 'DRAFT', 'mature', 'architect',    ARRAY['design','system-design'],       10),
    ('global', NULL, 14, 'DRAFT', 'mature', 'reviewer-d1',  ARRAY['review','gating'],              20),

    -- REVIEW / new — design reviewers
    ('global', NULL, 14, 'REVIEW', 'new',    'architect',        ARRAY['design','architecture'],   10),
    ('global', NULL, 14, 'REVIEW', 'new',    'skeptic',          ARRAY['review','gating','skeptic-review'], 20),
    -- REVIEW / mature — architecture gate (D2)
    ('global', NULL, 14, 'REVIEW', 'mature', 'skeptic-alpha',    ARRAY['review','gating','skeptic-review'], 10),
    ('global', NULL, 14, 'REVIEW', 'mature', 'reviewer-d2',      ARRAY['design','architecture'],   20),

    -- DEVELOP / new — build agents
    ('global', NULL, 14, 'DEVELOP', 'new',    'developer',    ARRAY['code'],                       10),
    ('global', NULL, 14, 'DEVELOP', 'new',    'engineer',     ARRAY['code'],                       20),
    -- DEVELOP / mature — implementation gate (D3)
    ('global', NULL, 14, 'DEVELOP', 'mature', 'skeptic-beta', ARRAY['review','code'],              10),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'reviewer-d3',  ARRAY['review','gating'],            20),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'qa',           ARRAY['review','code'],              30),

    -- MERGE / new — integration agents
    ('global', NULL, 14, 'MERGE', 'new',    'merge-agent',   ARRAY['devops','terminal'],           10),
    ('global', NULL, 14, 'MERGE', 'new',    'qa',            ARRAY['review','code'],               20),
    -- MERGE / mature — integration gate (D4)
    ('global', NULL, 14, 'MERGE', 'mature', 'reviewer-d4',   ARRAY['review','gating'],             10),
    ('global', NULL, 14, 'MERGE', 'mature', 'qa',            ARRAY['review','code'],               20),
    ('global', NULL, 14, 'MERGE', 'mature', 'maintainer',    ARRAY['devops'],                      30),
    ('global', NULL, 14, 'MERGE', 'mature', 'gate-agent',    ARRAY['gating'],                      40)

ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

-- ─── Seed: Hotfix (workflow_template_id = 37) ─────────────────────────────────
-- Compressed: only D1 (DRAFT/mature) and D3 (DEVELOP/mature) gates,
-- plus build agent for DEVELOP/new.

INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    -- DRAFT / new — hotfix architect
    ('global', NULL, 37, 'DRAFT', 'new',    'architect',    ARRAY['design','system-design'],       10),
    -- DRAFT / mature — spec gate
    ('global', NULL, 37, 'DRAFT', 'mature', 'architect',    ARRAY['design','system-design'],       10),
    ('global', NULL, 37, 'DRAFT', 'mature', 'reviewer-d1',  ARRAY['review','gating'],              20),

    -- DEVELOP / new — hotfix developer
    ('global', NULL, 37, 'DEVELOP', 'new',    'developer',  ARRAY['code'],                         10),
    -- DEVELOP / mature — implementation gate (D3)
    ('global', NULL, 37, 'DEVELOP', 'mature', 'skeptic-beta', ARRAY['review','code'],              10),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'reviewer-d3',  ARRAY['review','gating'],            20),

    -- MERGE / new
    ('global', NULL, 37, 'MERGE', 'new',    'merge-agent',  ARRAY['devops','terminal'],            10),
    -- MERGE / mature
    ('global', NULL, 37, 'MERGE', 'mature', 'reviewer-d4',  ARRAY['review','gating'],              10),
    ('global', NULL, 37, 'MERGE', 'mature', 'maintainer',   ARRAY['devops'],                       20)

ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

-- ─── Seed: Code Review Pipeline (workflow_template_id = 16) ──────────────────

INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    ('global', NULL, 16, 'REVIEW',  'new',    'architect',     ARRAY['design','architecture'],     10),
    ('global', NULL, 16, 'REVIEW',  'mature', 'skeptic-alpha', ARRAY['review','gating','skeptic-review'], 10),
    ('global', NULL, 16, 'DEVELOP', 'new',    'developer',     ARRAY['code'],                      10),
    ('global', NULL, 16, 'DEVELOP', 'mature', 'skeptic-beta',  ARRAY['review','code'],             10),
    ('global', NULL, 16, 'MERGE',   'new',    'merge-agent',   ARRAY['devops','terminal'],         10),
    ('global', NULL, 16, 'MERGE',   'mature', 'reviewer-d4',   ARRAY['review','gating'],           10)

ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

COMMIT;

-- ─── Rollback ─────────────────────────────────────────────────────────────────
-- To undo this migration:
--   DROP TRIGGER IF EXISTS trg_agent_role_profile_updated_at ON roadmap.agent_role_profile;
--   DROP FUNCTION IF EXISTS roadmap.set_agent_role_profile_updated_at();
--   DROP TABLE IF EXISTS roadmap.agent_role_profile;
