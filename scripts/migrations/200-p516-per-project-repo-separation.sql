-- P516: Per-project git repo separation — tenant code isolation
-- Adds git repository configuration columns to roadmap.project table
-- Enables each tenant to maintain separate code repositories

ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS git_repo_url TEXT,
  ADD COLUMN IF NOT EXISTS git_default_branch TEXT NOT NULL DEFAULT 'main';

COMMENT ON COLUMN roadmap.project.git_repo_url IS 'P516: URL/path of the tenant project''s git repository (e.g., git@gitlab.local:tenants/slug.git or /data/code/slug)';
COMMENT ON COLUMN roadmap.project.git_default_branch IS 'P516: Default branch for tenant code (default: main)';

GRANT SELECT, UPDATE ON roadmap.project TO xiaomi;
