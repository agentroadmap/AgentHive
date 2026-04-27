-- Migration 061: P599 — Tool Catalog and Grant Matrix
--
-- Creates roadmap.tool, roadmap.tool_grant, and roadmap.tool_invocation_log.
-- Seeds canonical shared utilities (git, gh, psql, MCP tools, HTTP APIs).
-- Idempotent: safe to re-run on a DB that already has these tables.
--
-- Prerequisites:
--   058-p472-principal-identity.sql — roadmap.principal_identity must exist
--   050-p482-phase1-project-registry.sql — roadmap.project must exist
--
-- PG 15+ required for UNIQUE NULLS NOT DISTINCT.

BEGIN;

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Migration 061 requires PostgreSQL 15+. Current: %', version();
  END IF;
END;
$$;

-- ── 1. Tool catalog ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.tool (
  tool_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_name  TEXT    UNIQUE NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('cli', 'mcp', 'http_api')),
  config     JSONB   NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.tool IS
  'P599: Central catalog of shared utilities (cli, mcp, http_api) available to agents.';
COMMENT ON COLUMN roadmap.tool.kind IS
  'Tool category: cli (git/gh/psql), mcp (MCP server tools), http_api (external HTTP endpoints).';
COMMENT ON COLUMN roadmap.tool.config IS
  'Freeform metadata — e.g. {"registry_id": 42} for mcp_tool_registry cross-ref.';

-- Reuse fn_set_updated_at if already installed by a prior migration (058).
-- CREATE OR REPLACE is safe whether or not the function already exists.
CREATE OR REPLACE FUNCTION roadmap.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_tool_updated_at'
      AND tgrelid = 'roadmap.tool'::regclass
  ) THEN
    CREATE TRIGGER trg_tool_updated_at
      BEFORE UPDATE ON roadmap.tool
      FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();
  END IF;
END;
$$;

-- ── 2. Grant matrix ──────────────────────────────────────────────────────────
--
-- (tool_id, project_id, agency_principal_id) → permitted_ops[]
-- NULL project_id          = global grant (any project)
-- NULL agency_principal_id = global grant (any agency)

CREATE TABLE IF NOT EXISTS roadmap.tool_grant (
  grant_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_id               BIGINT NOT NULL REFERENCES roadmap.tool (tool_id),
  project_id            BIGINT REFERENCES roadmap.project (project_id),
  agency_principal_id   TEXT   REFERENCES roadmap.principal_identity (principal_id),
  permitted_ops         TEXT[] NOT NULL,
  granted_by            TEXT,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,

  CONSTRAINT tool_grant_unique
    UNIQUE NULLS NOT DISTINCT (tool_id, project_id, agency_principal_id),

  -- Only agency: principals may appear here.
  CONSTRAINT chk_agency_principal_prefix
    CHECK (agency_principal_id IS NULL OR agency_principal_id LIKE 'agency:%'),

  -- ops must be non-empty strings in namespace:verb form.
  -- Wildcards are single-level only: namespace:* is valid; *:* is not.
  CONSTRAINT chk_permitted_ops_format
    CHECK (NOT EXISTS (
      SELECT 1 FROM unnest(permitted_ops) AS op
      WHERE op = ''
         OR op NOT LIKE '%:%'
         OR op LIKE '*:%'
         OR op LIKE '%:*:*'
    ))
);

COMMENT ON TABLE roadmap.tool_grant IS
  'P599: Per-(tool, project, agency) grant matrix. NULL in project_id or agency_principal_id means global.';
COMMENT ON COLUMN roadmap.tool_grant.permitted_ops IS
  'Array of namespace:verb ops. Wildcard namespace:* matches any verb within the namespace.';

CREATE INDEX IF NOT EXISTS tool_grant_lookup
  ON roadmap.tool_grant (project_id, agency_principal_id);

CREATE INDEX IF NOT EXISTS tool_grant_tool_idx
  ON roadmap.tool_grant (tool_id);

-- ── 3. Invocation log (stub) ─────────────────────────────────────────────────
--
-- Lightweight per-invocation audit trail.
-- Superseded by observability.trace_span when P605 lands; rows migrated then.

CREATE TABLE IF NOT EXISTS roadmap.tool_invocation_log (
  log_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_name    TEXT        NOT NULL,
  principal_id TEXT        NOT NULL,
  op           TEXT        NOT NULL,
  invoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB       NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE roadmap.tool_invocation_log IS
  'P599: Lightweight audit trail of tool invocations per principal. Stub until P605 ships observability.trace_span.';

CREATE INDEX IF NOT EXISTS til_principal_idx
  ON roadmap.tool_invocation_log (principal_id, invoked_at DESC);

CREATE INDEX IF NOT EXISTS til_tool_name_idx
  ON roadmap.tool_invocation_log (tool_name, invoked_at DESC);

-- ── 4. Seed canonical tools ──────────────────────────────────────────────────
--
-- Global grants (project_id IS NULL, agency_principal_id IS NULL) are seeded
-- for foundational CLI tools. Per-project seeds follow using roadmap.project ids.

-- Seed tool catalog rows first.
INSERT INTO roadmap.tool (tool_name, kind, config) VALUES
  ('git',          'cli',      '{}'),
  ('gh',           'cli',      '{}'),
  ('psql',         'cli',      '{}'),
  ('mcp_proposal', 'mcp',      '{}'),
  ('mcp_message',  'mcp',      '{}'),
  ('mcp_agent',    'mcp',      '{}'),
  ('mcp_document', 'mcp',      '{}'),
  ('mcp_memory',   'mcp',      '{}'),
  ('mcp_ops',      'mcp',      '{}'),
  ('mcp_project',  'mcp',      '{}'),
  ('roadmap_api',  'http_api', '{}')
ON CONFLICT (tool_name) DO NOTHING;

-- Global grants for git and gh (any project, any agency).
INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL, ARRAY['git:read', 'git:write'], 'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'git'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL, ARRAY['gh:pr', 'gh:issue', 'gh:workflow'], 'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'gh'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

-- Global grants for MCP tools (any project, any agency).
INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_proposal:read', 'mcp_proposal:write', 'mcp_proposal:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_proposal'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_message:read', 'mcp_message:write', 'mcp_message:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_message'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_agent:read', 'mcp_agent:write', 'mcp_agent:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_agent'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_document:read', 'mcp_document:write', 'mcp_document:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_document'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_memory:read', 'mcp_memory:write', 'mcp_memory:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_memory'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_ops:read', 'mcp_ops:write', 'mcp_ops:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_ops'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['mcp_project:read', 'mcp_project:write', 'mcp_project:*'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'mcp_project'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

INSERT INTO roadmap.tool_grant (tool_id, project_id, agency_principal_id, permitted_ops, granted_by)
SELECT t.tool_id, NULL, NULL,
  ARRAY['roadmap_api:read', 'roadmap_api:write'],
  'migration-061'
FROM roadmap.tool t WHERE t.tool_name = 'roadmap_api'
ON CONFLICT ON CONSTRAINT tool_grant_unique DO NOTHING;

-- psql is NOT globally granted — per-project, per-agency only (default-deny).
-- Explicit grants must be inserted per project/agency once they exist.

COMMIT;
