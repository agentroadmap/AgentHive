-- P516: Per-project git repo separation — git registry fields.
-- Adds git_repo_url and git_default_branch to roadmap.project.
-- worktree_root already exists (migration 050-p482-phase1-project-registry.sql).

ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS git_repo_url TEXT,
  ADD COLUMN IF NOT EXISTS git_default_branch TEXT NOT NULL DEFAULT 'main';

-- Compatibility for earlier P516 drafts that used git_remote_url.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'roadmap'
       AND table_name = 'project'
       AND column_name = 'git_remote_url'
  ) THEN
    EXECUTE 'UPDATE roadmap.project SET git_repo_url = COALESCE(git_repo_url, git_remote_url)';
  END IF;
END $$;

-- Index for CWD-based project resolution (control-plane-client resolveProjectFromCwd step 4).
CREATE INDEX IF NOT EXISTS idx_project_git_repo_url
  ON roadmap.project (LOWER(git_repo_url))
  WHERE git_repo_url IS NOT NULL;

COMMENT ON COLUMN roadmap.project.git_repo_url IS
  'Remote URL of the tenant git repo (e.g. git@gitlab.local:xiaomi/monkeyKing-audio.git). '
  'Used by resolveProjectFromCwd() to match the local checkout to its registry entry.';

COMMENT ON COLUMN roadmap.project.git_default_branch IS
  'Default branch for worktree operations (default: main).';

-- P516 allows tenant cubic worktrees under /data/code/<slug>/worktree while
-- preserving the current AgentHive exception at /data/code/worktree.
ALTER TABLE roadmap.cubics
  ADD COLUMN IF NOT EXISTS project_id BIGINT
  REFERENCES roadmap.project(project_id) ON DELETE SET NULL;

ALTER TABLE roadmap.cubics
  DROP CONSTRAINT IF EXISTS ck_cubics_worktree_path_canonical;

ALTER TABLE roadmap.cubics
  ADD CONSTRAINT ck_cubics_worktree_path_canonical
  CHECK (
    worktree_path LIKE '/data/code/worktree/%'
    OR worktree_path ~ '^/data/code/[^/]+/worktree/.+'
  ) NOT VALID;
