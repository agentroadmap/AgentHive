-- P516: Per-project git repo separation — git registry fields
-- Adds git_remote_url and git_default_branch to roadmap.project.
-- worktree_root already exists (migration 050-p482-phase1-project-registry.sql).

ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS git_remote_url TEXT,
  ADD COLUMN IF NOT EXISTS git_default_branch TEXT NOT NULL DEFAULT 'main';

-- Index for CWD-based project resolution (control-plane-client resolveProjectFromCwd step 4).
CREATE INDEX IF NOT EXISTS idx_project_git_remote_url
  ON roadmap.project (LOWER(git_remote_url))
  WHERE git_remote_url IS NOT NULL;

COMMENT ON COLUMN roadmap.project.git_remote_url IS
  'Remote URL of the tenant git repo (e.g. git@gitlab.local:xiaomi/monkeyKing-audio.git). '
  'Used by resolveProjectFromCwd() to match the local checkout to its registry entry.';

COMMENT ON COLUMN roadmap.project.git_default_branch IS
  'Default branch for worktree operations (default: main).';
