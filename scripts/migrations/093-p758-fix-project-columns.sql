-- P758 follow-up: add missing columns to roadmap.project
--
-- Migration 087 attempted to add dsn_secret_ref as a GENERATED column but
-- that column already exists as plain TEXT. This migration:
--   1. Adds the truly missing columns (tenant_db_url, display_name, pool_max,
--      idle_ms, stmt_timeout_ms) without touching dsn_secret_ref.
--   2. Widens project_status_check to include provisioning / suspended / retired.
--   3. Backfills display_name from name for existing rows.

BEGIN;

ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS tenant_db_url  TEXT,
  ADD COLUMN IF NOT EXISTS display_name   TEXT,
  ADD COLUMN IF NOT EXISTS pool_max       INT,
  ADD COLUMN IF NOT EXISTS idle_ms        INT,
  ADD COLUMN IF NOT EXISTS stmt_timeout_ms INT;

-- Widen status check: operator-side provisioning flow needs these states.
ALTER TABLE roadmap.project DROP CONSTRAINT IF EXISTS project_status_check;
ALTER TABLE roadmap.project ADD CONSTRAINT project_status_check
  CHECK (status IN ('active', 'archived', 'provisioning', 'suspended', 'retired'));

-- Backfill display_name for pre-existing rows.
UPDATE roadmap.project SET display_name = name WHERE display_name IS NULL;

COMMENT ON COLUMN roadmap.project.tenant_db_url IS
  'Full DSN for this project''s tenant database. NULL = same DB as hiveControl (single-tenant mode).';
COMMENT ON COLUMN roadmap.project.display_name IS
  'Human-readable label shown in dashboards; defaults to the name column.';
COMMENT ON COLUMN roadmap.project.pool_max IS
  'Max connections in the project pool. NULL = use pool-registry default (8).';
COMMENT ON COLUMN roadmap.project.idle_ms IS
  'Idle timeout ms for project pool. NULL = pool-registry default (300000).';
COMMENT ON COLUMN roadmap.project.stmt_timeout_ms IS
  'Statement timeout ms for project pool. NULL = pool-registry default (30000).';

COMMIT;

-- Rollback:
--   ALTER TABLE roadmap.project
--     DROP COLUMN IF EXISTS tenant_db_url,
--     DROP COLUMN IF EXISTS display_name,
--     DROP COLUMN IF EXISTS pool_max,
--     DROP COLUMN IF EXISTS idle_ms,
--     DROP COLUMN IF EXISTS stmt_timeout_ms;
--   ALTER TABLE roadmap.project DROP CONSTRAINT IF EXISTS project_status_check;
--   ALTER TABLE roadmap.project ADD CONSTRAINT project_status_check
--     CHECK (status IN ('active', 'archived'));
