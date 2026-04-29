-- P444: Host, Provider, and Route Separation
--
-- Untangles host identity from provider and agency by:
--   AC-1/AC-2: Extending agent_runs with 11 separate identity columns (all NULL-able;
--              old runs are unaffected — they simply get NULLs in new columns).
--   AC-4:      fn_resolve_route_preflight() — atomic pre-flight check that validates
--              route existence, enabled status, agent_provider match,
--              host_model_policy match (new allowed_route_providers column),
--              and staleness (last_validated_at vs stale_after_seconds).
--   AC-5:      All new agent_runs columns are nullable (backward compat for bot host).
--   AC-6:      control_git schema + worktree_policy table + fn_worktree_policy().
--
-- Migration boundary: NO data migration. Old rows keep NULLs. No CLI format changes.
-- Required capabilities: PostgreSQL 15+ (NULLS NOT DISTINCT available if needed).
--
-- Run AFTER 065-p289-provider-registry-enhancements.sql.

BEGIN;

-- ─── 1. host_model_policy: rename column + add staleness support ──────────────

-- Rename allowed_providers → allowed_route_providers.
-- Reflects that the check operates on route_provider (from model_routes),
-- not raw provider names or model strings.
ALTER TABLE roadmap.host_model_policy
  RENAME COLUMN allowed_providers TO allowed_route_providers;

COMMENT ON COLUMN roadmap.host_model_policy.allowed_route_providers IS
  'Allowed route_provider values (e.g. anthropic, nous, xiaomi, openai, google). '
  'Empty array = any non-forbidden route_provider is allowed.';

-- Staleness window. Policy rows are stamped with updated_at; fn_resolve_route_preflight
-- flags routes whose last_validated_at is older than this window.
ALTER TABLE roadmap.host_model_policy
  ADD COLUMN IF NOT EXISTS stale_after_seconds INT NOT NULL DEFAULT 3600
    CHECK (stale_after_seconds > 0);

COMMENT ON COLUMN roadmap.host_model_policy.stale_after_seconds IS
  'Seconds after which a model_route.last_validated_at is considered stale. '
  'fn_resolve_route_preflight will deny stale routes with reason=ROUTE_STALE.';

-- ─── 2. model_routes: add last_validated_at ───────────────────────────────────

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;

COMMENT ON COLUMN roadmap.model_routes.last_validated_at IS
  'Timestamp of the last successful reachability/health check for this route. '
  'NULL = never validated. Staleness is assessed against host_model_policy.stale_after_seconds.';

CREATE INDEX IF NOT EXISTS idx_model_routes_last_validated
  ON roadmap.model_routes (last_validated_at)
  WHERE is_enabled = true;

-- ─── 3. agent_runs: add separation columns (all nullable, backward compat) ────

ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS dispatch_id         BIGINT,
  ADD COLUMN IF NOT EXISTS agency_id           TEXT,
  ADD COLUMN IF NOT EXISTS worker_id           TEXT,
  ADD COLUMN IF NOT EXISTS host_id             TEXT,
  ADD COLUMN IF NOT EXISTS provider_account_id BIGINT,
  ADD COLUMN IF NOT EXISTS route_id            BIGINT,
  ADD COLUMN IF NOT EXISTS agent_cli           TEXT,
  ADD COLUMN IF NOT EXISTS agent_provider      TEXT,
  ADD COLUMN IF NOT EXISTS route_provider      TEXT,
  ADD COLUMN IF NOT EXISTS auth_source_class   TEXT,
  ADD COLUMN IF NOT EXISTS worktree_id         TEXT;

COMMENT ON COLUMN roadmap_workforce.agent_runs.dispatch_id IS
  'FK → squad_dispatch.id. NULL for runs not started from a work offer.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agency_id IS
  'Denormalized agency_identity from agent_registry at time of run.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.worker_id IS
  'Denormalized worker identity (agent_identity of the leaf worker).';
COMMENT ON COLUMN roadmap_workforce.agent_runs.host_id IS
  'hostname() at spawn time — derived from AGENTHIVE_HOST env var.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.provider_account_id IS
  'FK → provider_account table (if any). NULL for hosts with no account registration.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.route_id IS
  'FK → model_routes.id resolved at spawn time. NULL for legacy runs.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agent_cli IS
  'CLI tool used to launch the agent (claude, hermes, copilot, …).';
COMMENT ON COLUMN roadmap_workforce.agent_runs.agent_provider IS
  'AgentProvider enum value at spawn time (claude, gemini, copilot, openclaw).';
COMMENT ON COLUMN roadmap_workforce.agent_runs.route_provider IS
  'route_provider from model_routes at spawn time (anthropic, nous, xiaomi, …).';
COMMENT ON COLUMN roadmap_workforce.agent_runs.auth_source_class IS
  'Class of auth credential used (api_key, token_plan, oauth, env_passthrough).';
COMMENT ON COLUMN roadmap_workforce.agent_runs.worktree_id IS
  'Git worktree identifier if the run was isolated in a dedicated worktree.';

-- Useful lookup: all runs for a given route
CREATE INDEX IF NOT EXISTS idx_agent_runs_route_id
  ON roadmap_workforce.agent_runs (route_id)
  WHERE route_id IS NOT NULL;

-- ─── 4. Update fn_check_spawn_policy to use renamed column ───────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_check_spawn_policy(
    p_host          TEXT,
    p_route_provider TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN p.host_name IS NULL              THEN TRUE   -- unknown host: legacy permit
        WHEN p_route_provider = ANY(p.forbidden_providers)  THEN FALSE  -- explicit forbid wins
        WHEN cardinality(p.allowed_route_providers) = 0     THEN TRUE   -- empty allow-list = permit
        ELSE p_route_provider = ANY(p.allowed_route_providers)
    END
    FROM roadmap.host_model_policy p
    WHERE p.host_name = p_host
    UNION ALL
    SELECT TRUE
    WHERE NOT EXISTS (SELECT 1 FROM roadmap.host_model_policy WHERE host_name = p_host)
    LIMIT 1;
$$;

COMMENT ON FUNCTION roadmap.fn_check_spawn_policy(TEXT, TEXT) IS
    'Returns TRUE if route_provider is allowed on this host. '
    'Unknown hosts are permitted (legacy fallback). '
    'Column renamed to allowed_route_providers in P444.';

-- ─── 5. _log_spawn_violation helper ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap._log_spawn_violation(
  p_proposal_id    TEXT,
  p_agent_identity TEXT,
  p_reason         TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap, pg_catalog
AS $$
BEGIN
  INSERT INTO roadmap.escalation_log (
    obstacle_type,
    proposal_id,
    agent_identity,
    escalated_to,
    severity,
    resolution_note
  ) VALUES (
    'SPAWN_POLICY_VIOLATION',
    p_proposal_id,
    p_agent_identity,
    'orchestrator',
    'high',
    p_reason
  );
END;
$$;

COMMENT ON FUNCTION roadmap._log_spawn_violation(TEXT, TEXT, TEXT) IS
  'Internal helper: records a SPAWN_POLICY_VIOLATION to escalation_log. '
  'Called by fn_resolve_route_preflight on rejection.';

-- ─── 6. fn_resolve_route_preflight: atomic pre-flight check ─────────────────
--
-- AC-4: checks (in order, short-circuit on first failure):
--   (a) route exists in model_routes
--   (b) route is enabled
--   (c) route.agent_provider matches the caller's p_agent_provider
--   (d) host_model_policy.allowed_route_providers includes route_provider
--       (or forbidden_providers excludes it)
--   (e) route.last_validated_at is within host_model_policy.stale_after_seconds
--       (NULL last_validated_at is treated as fresh to allow unvalidated routes)
--
-- Returns TABLE(allowed BOOLEAN, reason TEXT).
-- reason is NULL when allowed=TRUE, otherwise a short diagnostic string.

CREATE OR REPLACE FUNCTION roadmap.fn_resolve_route_preflight(
  p_host          TEXT,
  p_route_id      BIGINT,
  p_agent_provider TEXT
) RETURNS TABLE (allowed BOOLEAN, reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = roadmap, pg_catalog
AS $$
DECLARE
  v_route_provider   TEXT;
  v_is_enabled       BOOLEAN;
  v_route_agent_prov TEXT;
  v_last_validated   TIMESTAMPTZ;
  v_policy           roadmap.host_model_policy%ROWTYPE;
  v_stale_after      INT;
BEGIN
  -- (a) Route must exist
  SELECT mr.route_provider, mr.is_enabled, mr.agent_provider, mr.last_validated_at
  INTO   v_route_provider, v_is_enabled, v_route_agent_prov, v_last_validated
  FROM   roadmap.model_routes mr
  WHERE  mr.id = p_route_id;

  IF v_route_provider IS NULL THEN
    RETURN QUERY SELECT FALSE, 'ROUTE_NOT_FOUND'::TEXT;
    RETURN;
  END IF;

  -- (b) Route must be enabled
  IF NOT v_is_enabled THEN
    RETURN QUERY SELECT FALSE, 'ROUTE_DISABLED'::TEXT;
    RETURN;
  END IF;

  -- (c) agent_provider must match
  IF v_route_agent_prov <> p_agent_provider THEN
    RETURN QUERY SELECT FALSE,
      format('AGENT_PROVIDER_MISMATCH: route expects %s, got %s',
             v_route_agent_prov, p_agent_provider)::TEXT;
    RETURN;
  END IF;

  -- (d/e) Check host policy (if host is unknown, legacy permit applies)
  SELECT * INTO v_policy
  FROM roadmap.host_model_policy
  WHERE host_name = p_host;

  IF FOUND THEN
    -- (d) forbidden_providers wins
    IF v_route_provider = ANY(v_policy.forbidden_providers) THEN
      RETURN QUERY SELECT FALSE,
        format('POLICY_FORBIDDEN: %s is forbidden on host %s',
               v_route_provider, p_host)::TEXT;
      RETURN;
    END IF;

    -- (d) allowed_route_providers check (empty = allow all non-forbidden)
    IF cardinality(v_policy.allowed_route_providers) > 0
       AND NOT (v_route_provider = ANY(v_policy.allowed_route_providers)) THEN
      RETURN QUERY SELECT FALSE,
        format('POLICY_NOT_ALLOWED: %s not in allowed_route_providers for host %s',
               v_route_provider, p_host)::TEXT;
      RETURN;
    END IF;

    -- (e) Staleness check — skip if last_validated_at IS NULL (treat as fresh)
    v_stale_after := v_policy.stale_after_seconds;
    IF v_last_validated IS NOT NULL
       AND v_last_validated < now() - make_interval(secs => v_stale_after) THEN
      RETURN QUERY SELECT FALSE,
        format('ROUTE_STALE: last_validated_at %s is older than %s seconds',
               v_last_validated, v_stale_after)::TEXT;
      RETURN;
    END IF;
  END IF;

  -- All checks passed
  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_resolve_route_preflight(TEXT, BIGINT, TEXT) IS
  'AC-4 pre-flight gate. Checks route existence, enabled status, agent_provider match, '
  'host policy (allowed_route_providers / forbidden_providers), and route staleness. '
  'Returns (allowed=TRUE, reason=NULL) on pass; (FALSE, reason) on rejection. '
  'Unknown hosts (not in host_model_policy) are legacy-permitted. '
  'NULL last_validated_at is treated as fresh (unvalidated routes are allowed).';

-- ─── 7. control_git schema + worktree_policy (AC-6) ─────────────────────────

CREATE SCHEMA IF NOT EXISTS control_git;

COMMENT ON SCHEMA control_git IS
  'Git/worktree policy tables for the AgentHive control plane (P444).';

CREATE TABLE IF NOT EXISTS control_git.worktree_policy (
  id                    BIGSERIAL    PRIMARY KEY,
  project_id            BIGINT,
  repo_id               BIGINT,
  worktree_root_pattern TEXT         NOT NULL,
  description           TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT worktree_policy_project_repo_uniq
    UNIQUE NULLS NOT DISTINCT (project_id, repo_id)
);

COMMENT ON TABLE control_git.worktree_policy IS
  'Worktree root override rules per (project_id, repo_id). '
  'NULL project_id or repo_id acts as a wildcard for that dimension.';
COMMENT ON COLUMN control_git.worktree_policy.worktree_root_pattern IS
  'Pattern for the worktree root directory. May include {project}, {repo}, {branch} placeholders.';

CREATE INDEX IF NOT EXISTS idx_worktree_policy_project
  ON control_git.worktree_policy (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_worktree_policy_repo
  ON control_git.worktree_policy (repo_id)
  WHERE repo_id IS NOT NULL;

-- AC-6: fn_worktree_policy — most-specific match wins.
-- Specificity order: (project+repo) > (project only) > (repo only) > (global NULL/NULL).
-- Returns worktree_root_pattern, or NULL if no policy applies.

CREATE OR REPLACE FUNCTION control_git.fn_worktree_policy(
  p_project_id BIGINT,
  p_repo_id    BIGINT
) RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT worktree_root_pattern
  FROM control_git.worktree_policy
  WHERE
    (project_id = p_project_id AND repo_id = p_repo_id)
    OR (project_id = p_project_id AND repo_id IS NULL)
    OR (project_id IS NULL        AND repo_id = p_repo_id)
    OR (project_id IS NULL        AND repo_id IS NULL)
  ORDER BY
    -- Most specific first: both non-null > one non-null > global
    (CASE WHEN project_id IS NOT NULL AND repo_id IS NOT NULL THEN 0
          WHEN project_id IS NOT NULL OR  repo_id IS NOT NULL THEN 1
          ELSE 2 END) ASC,
    id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION control_git.fn_worktree_policy(BIGINT, BIGINT) IS
  'AC-6: returns worktree_root_pattern for the given (project_id, repo_id) pair, '
  'selecting the most-specific matching row. Returns NULL if no policy applies. '
  'Specificity: (project+repo) > (project only) > (repo only) > global.';

-- ─── 8. Validation ───────────────────────────────────────────────────────────

DO $$
BEGIN
  -- host_model_policy column rename
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap'
      AND table_name = 'host_model_policy'
      AND column_name = 'allowed_route_providers'
  ) THEN
    RAISE EXCEPTION 'P444: allowed_route_providers column missing on host_model_policy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap'
      AND table_name = 'host_model_policy'
      AND column_name = 'allowed_providers'
  ) THEN
    RAISE EXCEPTION 'P444: old allowed_providers column still present on host_model_policy';
  END IF;

  -- stale_after_seconds
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap'
      AND table_name = 'host_model_policy'
      AND column_name = 'stale_after_seconds'
  ) THEN
    RAISE EXCEPTION 'P444: stale_after_seconds column missing on host_model_policy';
  END IF;

  -- last_validated_at on model_routes
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap'
      AND table_name = 'model_routes'
      AND column_name = 'last_validated_at'
  ) THEN
    RAISE EXCEPTION 'P444: last_validated_at column missing on model_routes';
  END IF;

  -- agent_runs columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'agent_runs'
      AND column_name = 'route_id'
  ) THEN
    RAISE EXCEPTION 'P444: route_id column missing on agent_runs';
  END IF;

  -- control_git schema
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata
    WHERE schema_name = 'control_git'
  ) THEN
    RAISE EXCEPTION 'P444: control_git schema missing';
  END IF;

  -- worktree_policy table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'control_git' AND table_name = 'worktree_policy'
  ) THEN
    RAISE EXCEPTION 'P444: control_git.worktree_policy table missing';
  END IF;

  -- Functions
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap' AND p.proname = 'fn_resolve_route_preflight'
  ) THEN
    RAISE EXCEPTION 'P444: fn_resolve_route_preflight function missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'control_git' AND p.proname = 'fn_worktree_policy'
  ) THEN
    RAISE EXCEPTION 'P444: control_git.fn_worktree_policy function missing';
  END IF;

  RAISE NOTICE 'P444 migration 066 validated OK';
END $$;

COMMIT;
