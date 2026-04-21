-- Migration 038: P281 Resource Hierarchy — Worktree Pool, Cubics Update, Model Routes Simplification
--
-- New hierarchy: Branch → Worktree → Cubic → Agent
--
-- Changes:
--   1. Create worktree_pool table
--   2. Update cubics: add branch_name, worktree_id FK, drop agent_identity
--   3. Simplify model_routes: drop agent_cli, drop per-1k, rename per-million

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Create worktree_pool table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.worktree_pool (
    worktree_id     TEXT PRIMARY KEY DEFAULT ('wt-' || LPAD(FLOOR(RANDOM() * 999999)::INT::TEXT, 6, '0')),
    branch_name     TEXT NOT NULL,
    worktree_path   TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'idle'
                        CHECK (status IN ('idle', 'active', 'draining', 'stale')),
    assigned_cubic  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'::jsonb
);

COMMENT ON TABLE roadmap.worktree_pool IS
  'Durable git worktree pool. No embedded secrets. DB creds inherited from hosting CLI.';

CREATE INDEX IF NOT EXISTS idx_worktree_pool_status ON roadmap.worktree_pool(status);
CREATE INDEX IF NOT EXISTS idx_worktree_pool_branch_status ON roadmap.worktree_pool(branch_name, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Update cubics table
-- ─────────────────────────────────────────────────────────────────────────────

-- Add new columns
ALTER TABLE roadmap.cubics
  ADD COLUMN IF NOT EXISTS branch_name TEXT;

ALTER TABLE roadmap.cubics
  ADD COLUMN IF NOT EXISTS worktree_id TEXT;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_cubics_branch ON roadmap.cubics(branch_name);
CREATE INDEX IF NOT EXISTS idx_cubics_worktree_id ON roadmap.cubics(worktree_id);

-- Drop agent_identity (agent is ephemeral, assigned at dispatch)
ALTER TABLE roadmap.cubics DROP COLUMN IF EXISTS agent_identity;

-- Make worktree_path nullable (backward compat, populated from FK)
ALTER TABLE roadmap.cubics ALTER COLUMN worktree_path DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Simplify model_routes table
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop agent_cli (derive from agent_provider in code)
ALTER TABLE roadmap.model_routes DROP COLUMN IF EXISTS agent_cli;

-- Drop legacy per-1k pricing
ALTER TABLE roadmap.model_routes DROP COLUMN IF EXISTS cost_per_1k_input;
ALTER TABLE roadmap.model_routes DROP COLUMN IF EXISTS cost_per_1k_output;

-- Rename per-million columns to shorter names
ALTER TABLE roadmap.model_routes
  RENAME COLUMN cost_per_million_input TO cost_input_per_m;

ALTER TABLE roadmap.model_routes
  RENAME COLUMN cost_per_million_output TO cost_output_per_m;

ALTER TABLE roadmap.model_routes
  RENAME COLUMN cost_per_million_cache_write TO cost_cache_write_per_m;

ALTER TABLE roadmap.model_routes
  RENAME COLUMN cost_per_million_cache_hit TO cost_cache_hit_per_m;

-- Update comments
COMMENT ON COLUMN roadmap.model_routes.cost_input_per_m IS
  'USD per 1M input tokens for this route';
COMMENT ON COLUMN roadmap.model_routes.cost_output_per_m IS
  'USD per 1M output tokens for this route';
COMMENT ON COLUMN roadmap.model_routes.cost_cache_write_per_m IS
  'USD per 1M cache write tokens for this route';
COMMENT ON COLUMN roadmap.model_routes.cost_cache_hit_per_m IS
  'USD per 1M cache hit/read tokens for this route';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Add FK constraint (after cubics has worktree_id column)
-- ─────────────────────────────────────────────────────────────────────────────

-- Add FK from worktree_pool.assigned_cubic → cubics
ALTER TABLE roadmap.worktree_pool
  ADD CONSTRAINT fk_worktree_pool_assigned_cubic
  FOREIGN KEY (assigned_cubic) REFERENCES roadmap.cubics(cubic_id) ON DELETE SET NULL;

-- Add FK from cubics.worktree_id → worktree_pool
ALTER TABLE roadmap.cubics
  ADD CONSTRAINT fk_cubics_worktree_id
  FOREIGN KEY (worktree_id) REFERENCES roadmap.worktree_pool(worktree_id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Grant access
-- ─────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.worktree_pool TO roadmap_agent;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Data migration: populate branch_name from existing worktree_path values
-- ─────────────────────────────────────────────────────────────────────────────

-- For existing cubics with worktree_path, extract branch from path pattern
-- Pattern: /data/code/worktree/<branch-suffix> → branch = branch-suffix
UPDATE roadmap.cubics
SET branch_name = CASE
    WHEN worktree_path LIKE '/data/code/worktree/%' THEN
      REPLACE(worktree_path, '/data/code/worktree/', '')
    ELSE 'main'  -- default for unknown paths
END
WHERE branch_name IS NULL AND worktree_path IS NOT NULL;

-- Set branch_name = 'main' for cubics with NULL worktree_path
UPDATE roadmap.cubics
SET branch_name = 'main'
WHERE branch_name IS NULL;

COMMIT;
