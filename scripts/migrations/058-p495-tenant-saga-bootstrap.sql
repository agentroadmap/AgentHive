-- P495: Per-Project Tenant DB Bootstrap + Connection Registry (Saga Pattern)
-- Extends roadmap.project table with tenant DB columns and audit/repair infrastructure.

-- Step 1: Extend roadmap.project with tenant DB columns
ALTER TABLE roadmap.project
ADD COLUMN IF NOT EXISTS db_name TEXT,
ADD COLUMN IF NOT EXISTS db_role TEXT,
ADD COLUMN IF NOT EXISTS schema_prefix TEXT,
ADD COLUMN IF NOT EXISTS dsn_secret_ref TEXT,
ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT '127.0.0.1',
ADD COLUMN IF NOT EXISTS port INT NOT NULL DEFAULT 6432,
ADD COLUMN IF NOT EXISTS bootstrap_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (bootstrap_status IN ('pending', 'db_role_created', 'db_created', 'schema_loaded', 'vault_written', 'live', 'failed', 'ops_setup_failed')),
ADD COLUMN IF NOT EXISTS bootstrap_log JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Step 2: Create/Migrate project_repair_queue table (P495 schema)
-- Drop old table if exists with legacy schema, then create new P495 schema
DROP TABLE IF EXISTS roadmap.project_repair_queue CASCADE;

CREATE TABLE roadmap.project_repair_queue (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  failure_reason TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'in_progress', 'completed', 'escalated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_project_repair_queue_status_attempt
  ON roadmap.project_repair_queue(status, next_attempt_at);

-- Step 3: Ensure audit_log table exists (created elsewhere; add missing columns if needed)
-- This assumes audit_log is created by P488 or similar; we just ensure required cols exist
-- TODO: Verify audit_log table schema matches P495 expectations

-- Step 4: Update seed projects with bootstrap_status = 'pending' (not 'live')
-- These will be manually upgraded to 'live' by operator via project_create
UPDATE roadmap.project
SET bootstrap_status = 'pending'
WHERE slug IN ('audiobook', 'ai-singer')
AND bootstrap_status IS NULL;

-- agenthive (project_id=1) will be grandfathered via project_attach in P507
-- For now, mark as pending; P507 changes this to 'live' after validation

-- Step 5: Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION roadmap.update_project_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_project_updated_at ON roadmap.project;
CREATE TRIGGER trigger_project_updated_at
BEFORE UPDATE ON roadmap.project
FOR EACH ROW
EXECUTE FUNCTION roadmap.update_project_timestamp();

-- Step 6: Backfill existing projects with placeholder values (safe defaults)
-- Only for rows that already exist (agenthive, audiobook, ai-singer)
UPDATE roadmap.project
SET
  db_name = COALESCE(db_name, slug),
  db_role = COALESCE(db_role, slug || '_owner'),
  schema_prefix = COALESCE(schema_prefix, slug || '_'),
  dsn_secret_ref = COALESCE(dsn_secret_ref, 'vault://file/project/' || slug || '/dsn'),
  bootstrap_status = COALESCE(NULLIF(bootstrap_status, 'pending'), 'pending'),
  host = COALESCE(NULLIF(host, ''), '127.0.0.1'),
  port = COALESCE(NULLIF(port, 0), 6432)
WHERE db_name IS NULL OR db_role IS NULL;
