-- P748: Agent Role Profile Schema
--
-- Introduces the `roadmap.agent_role_profile` table to map
-- (workflow_template_id, stage, maturity, role) → agent requirements.
--
-- Two-tier resolution:
--   1. DB rows (with project-level overrides shadowing global)
--   2. BUILTIN_FALLBACK literals in role-resolver.ts (when DB empty)
--
-- This migration seeds profiles for Standard RFC (template_id=14) and Hotfix (template_id=37).

BEGIN;

-- ─── Create agent_role_profile table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.agent_role_profile (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope                 TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','project')),
    project_id            BIGINT NULL,
    workflow_template_id  BIGINT NOT NULL,
    stage                 TEXT NOT NULL,
    maturity              TEXT NOT NULL CHECK (maturity IN ('new','active','mature','obsolete')),
    role                  TEXT NOT NULL,
    required_capabilities TEXT[] NOT NULL DEFAULT '{}',
    allowed_route_providers TEXT[] NULL,
    forbidden_route_providers TEXT[] NULL,
    prompt_template       JSONB NULL,
    priority              INTEGER NOT NULL DEFAULT 100,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_role_profile_unique UNIQUE NULLS NOT DISTINCT
        (scope, project_id, workflow_template_id, stage, maturity, role)
);

-- ─── Create indexes for lookup performance ────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_agent_role_profile_lookup
    ON roadmap.agent_role_profile(workflow_template_id, stage, maturity);

CREATE INDEX IF NOT EXISTS idx_agent_role_profile_scope
    ON roadmap.agent_role_profile(scope, project_id);

-- ─── Seed Standard RFC (template_id=14) ───────────────────────────────────────
-- All 4 stages × 2 maturity bands (new/active → build; mature/obsolete → gate reviewers)

INSERT INTO roadmap.agent_role_profile
    (scope, workflow_template_id, stage, maturity, role, priority)
VALUES
    -- DRAFT / new → researcher, architect
    ('global', 14, 'DRAFT', 'new', 'researcher', 10),
    ('global', 14, 'DRAFT', 'new', 'architect', 20),
    -- DRAFT / active → researcher, architect (same as new)
    ('global', 14, 'DRAFT', 'active', 'researcher', 10),
    ('global', 14, 'DRAFT', 'active', 'architect', 20),
    -- DRAFT / mature → architect, reviewer-d1 (gating reviewers)
    ('global', 14, 'DRAFT', 'mature', 'architect', 10),
    ('global', 14, 'DRAFT', 'mature', 'reviewer-d1', 20),

    -- REVIEW / new → architect, skeptic (build agents for enhancement)
    ('global', 14, 'REVIEW', 'new', 'architect', 10),
    ('global', 14, 'REVIEW', 'new', 'skeptic', 20),
    -- REVIEW / active → architect, skeptic (same as new)
    ('global', 14, 'REVIEW', 'active', 'architect', 10),
    ('global', 14, 'REVIEW', 'active', 'skeptic', 20),
    -- REVIEW / mature → skeptic-alpha, reviewer-d2, architect (gating reviewers)
    ('global', 14, 'REVIEW', 'mature', 'skeptic-alpha', 10),
    ('global', 14, 'REVIEW', 'mature', 'reviewer-d2', 20),
    ('global', 14, 'REVIEW', 'mature', 'architect', 30),

    -- DEVELOP / new → developer, engineer (build agents for implementation)
    ('global', 14, 'DEVELOP', 'new', 'developer', 10),
    ('global', 14, 'DEVELOP', 'new', 'engineer', 20),
    -- DEVELOP / active → developer, engineer (same as new)
    ('global', 14, 'DEVELOP', 'active', 'developer', 10),
    ('global', 14, 'DEVELOP', 'active', 'engineer', 20),
    -- DEVELOP / mature → skeptic-beta, reviewer-d3, qa (gating reviewers)
    ('global', 14, 'DEVELOP', 'mature', 'skeptic-beta', 10),
    ('global', 14, 'DEVELOP', 'mature', 'reviewer-d3', 20),
    ('global', 14, 'DEVELOP', 'mature', 'qa', 30),

    -- MERGE / new → qa, integration (build agents for merge validation)
    ('global', 14, 'MERGE', 'new', 'qa', 10),
    ('global', 14, 'MERGE', 'new', 'integration', 20),
    -- MERGE / active → qa, integration (same as new)
    ('global', 14, 'MERGE', 'active', 'qa', 10),
    ('global', 14, 'MERGE', 'active', 'integration', 20),
    -- MERGE / mature → reviewer-d4, qa, maintainer, gate-agent (gating reviewers)
    ('global', 14, 'MERGE', 'mature', 'reviewer-d4', 10),
    ('global', 14, 'MERGE', 'mature', 'qa', 20),
    ('global', 14, 'MERGE', 'mature', 'maintainer', 30),
    ('global', 14, 'MERGE', 'mature', 'gate-agent', 40)

ON CONFLICT DO NOTHING;

-- ─── Seed Hotfix (template_id=37) ─────────────────────────────────────────────
-- DRAFT and DEVELOP only (no REVIEW, no MERGE)

INSERT INTO roadmap.agent_role_profile
    (scope, workflow_template_id, stage, maturity, role, priority)
VALUES
    -- DRAFT / new → researcher, architect
    ('global', 37, 'DRAFT', 'new', 'researcher', 10),
    ('global', 37, 'DRAFT', 'new', 'architect', 20),
    -- DRAFT / active → researcher, architect (same as new)
    ('global', 37, 'DRAFT', 'active', 'researcher', 10),
    ('global', 37, 'DRAFT', 'active', 'architect', 20),
    -- DRAFT / mature → architect, reviewer-d1 (gating reviewers)
    ('global', 37, 'DRAFT', 'mature', 'architect', 10),
    ('global', 37, 'DRAFT', 'mature', 'reviewer-d1', 20),

    -- DEVELOP / new → developer, engineer (build agents for implementation)
    ('global', 37, 'DEVELOP', 'new', 'developer', 10),
    ('global', 37, 'DEVELOP', 'new', 'engineer', 20),
    -- DEVELOP / active → developer, engineer (same as new)
    ('global', 37, 'DEVELOP', 'active', 'developer', 10),
    ('global', 37, 'DEVELOP', 'active', 'engineer', 20),
    -- DEVELOP / mature → skeptic-beta, reviewer-d3, qa (gating reviewers)
    ('global', 37, 'DEVELOP', 'mature', 'skeptic-beta', 10),
    ('global', 37, 'DEVELOP', 'mature', 'reviewer-d3', 20),
    ('global', 37, 'DEVELOP', 'mature', 'qa', 30)

ON CONFLICT DO NOTHING;

COMMIT;
