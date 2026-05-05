-- Migration 073: P444 — Host, Provider, and Route Separation
--
-- Separates the run-record identity fields that were previously collapsed
-- into agent_identity (worktree string) into discrete, queryable columns.
--
-- All new columns are nullable so existing INSERTs (older orchestrator code
-- that hasn't been updated yet) continue to work without modification.
-- Populate them by passing the new SpawnRequest fields (dispatchId, agencyId,
-- workerId, hostId, routeId, providerAccountId, authSourceClass).
--
-- Also adds:
--   control_git.worktree_policy(project_id, repo_id) — AC#6
--     Returns the worktree root pattern for a given (project, repo) pair.
--     Defaults to '/data/code/worktree' when no project-specific override exists.
--
-- Idempotent: all DDL guarded with IF NOT EXISTS / CREATE OR REPLACE.

-- ── 1. New columns on agent_runs ──────────────────────────────────────────────

-- Dispatch that triggered this agent run (roadmap_workforce.dispatches.id)
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS dispatch_id       BIGINT       NULL;

-- Agency that owns the worker (roadmap_workforce.agencies.id or identity string)
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS agency_id         TEXT         NULL;

-- Worker slot within the agency (e.g. "worker-15411")
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS worker_id         TEXT         NULL;

-- Physical / logical host that executed the spawn (AGENTHIVE_HOST value)
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS host_id           TEXT         NULL;

-- Provider account identifier (e.g. account slug or API key fingerprint)
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT       NULL;

-- FK to roadmap.model_routes.id — the exact route row used for this run
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS route_id          INTEGER      NULL;

-- Agent CLI identifier (e.g. "hermes", "claude", "codex")
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS agent_cli         TEXT         NULL;

-- Agent provider string (e.g. "openclaw", "anthropic")
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS agent_provider    TEXT         NULL;

-- Route provider string (e.g. "nous", "anthropic", "openai")
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS route_provider    TEXT         NULL;

-- Auth source classification (e.g. "env_file", "db_primary", "db_secondary")
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS auth_source_class TEXT         NULL;

-- Project this run is scoped to (roadmap_proposal.projects.id or tenant slug)
ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS project_id        BIGINT       NULL;

COMMENT ON COLUMN roadmap_workforce.agent_runs.dispatch_id
  IS 'P444: FK to dispatches — the dispatch that triggered this run';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agency_id
  IS 'P444: Agency identity that owns the worker';
COMMENT ON COLUMN roadmap_workforce.agent_runs.worker_id
  IS 'P444: Worker slot identity within the agency';
COMMENT ON COLUMN roadmap_workforce.agent_runs.host_id
  IS 'P444: Physical host where the spawn ran (AGENTHIVE_HOST)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.provider_account_id
  IS 'P444: Provider account identifier (fingerprint or slug)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.route_id
  IS 'P444: FK to roadmap.model_routes — exact route row used';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agent_cli
  IS 'P444: CLI binary used (hermes / claude / codex)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agent_provider
  IS 'P444: Agent provider string (openclaw / anthropic / …)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.route_provider
  IS 'P444: Route provider string (nous / anthropic / openai / …)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.auth_source_class
  IS 'P444: How the API key was sourced (env_file / db_primary / db_secondary)';
COMMENT ON COLUMN roadmap_workforce.agent_runs.project_id
  IS 'P444: Project scope for multi-tenant runs';

-- ── 2. control_git schema + worktree_policy function (AC#6) ───────────────────

CREATE SCHEMA IF NOT EXISTS control_git;

-- Per-project worktree root overrides. When absent the global default is used.
CREATE TABLE IF NOT EXISTS control_git.worktree_overrides (
  id          SERIAL PRIMARY KEY,
  project_id  BIGINT       NOT NULL,
  repo_id     BIGINT       NOT NULL,
  root_pattern TEXT        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (project_id, repo_id)
);

COMMENT ON TABLE control_git.worktree_overrides
  IS 'P444 AC#6: Per-project worktree root pattern overrides. Row absent = use global default.';

-- AC#6: worktree_policy(project_id, repo_id) → root_pattern TEXT
-- Returns the worktree root pattern for a (project, repo) pair.
-- Falls back to '/data/code/worktree' when no override is registered.
CREATE OR REPLACE FUNCTION control_git.worktree_policy(
  p_project_id BIGINT,
  p_repo_id    BIGINT
) RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_pattern TEXT;
BEGIN
  SELECT root_pattern
    INTO v_pattern
    FROM control_git.worktree_overrides
   WHERE project_id = p_project_id
     AND repo_id    = p_repo_id
   LIMIT 1;

  RETURN COALESCE(v_pattern, '/data/code/worktree');
END;
$$;

COMMENT ON FUNCTION control_git.worktree_policy(BIGINT, BIGINT)
  IS 'P444 AC#6: Returns worktree root pattern for (project_id, repo_id). Defaults to /data/code/worktree.';

-- ── 3. Index on host_id for host-scoped run queries ───────────────────────────

CREATE INDEX IF NOT EXISTS agent_runs_host_id_idx
  ON roadmap_workforce.agent_runs (host_id)
  WHERE host_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runs_route_id_idx
  ON roadmap_workforce.agent_runs (route_id)
  WHERE route_id IS NOT NULL;
