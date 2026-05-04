-- P758: Add tenant_db_url and pool config columns to roadmap.project
-- Adds the columns that pool-registry.ts expects (dsn_secret_ref, pool_max,
-- idle_ms, stmt_timeout_ms) plus tenant_db_url and display_name from the spec.

ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS tenant_db_url TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS dsn_secret_ref TEXT GENERATED ALWAYS AS (tenant_db_url) STORED,
  ADD COLUMN IF NOT EXISTS pool_max INT,
  ADD COLUMN IF NOT EXISTS idle_ms INT,
  ADD COLUMN IF NOT EXISTS stmt_timeout_ms INT;

-- Widen the status check to include provisioning, suspended, and retired.
ALTER TABLE roadmap.project DROP CONSTRAINT IF EXISTS project_status_check;
ALTER TABLE roadmap.project ADD CONSTRAINT project_status_check
  CHECK (status IN ('active', 'archived', 'provisioning', 'suspended', 'retired'));

-- Backfill display_name from the existing name column for all current rows.
-- tenant_db_url is intentionally left NULL; the operator sets it per deployment.
UPDATE roadmap.project SET display_name = name WHERE display_name IS NULL;

COMMENT ON COLUMN roadmap.project.tenant_db_url IS
  'Full DSN for this project''s tenant database. NULL = same DB as hiveControl (single-tenant mode). Operator must set this before the pool registry can resolve a per-tenant connection.';
COMMENT ON COLUMN roadmap.project.dsn_secret_ref IS
  'Generated column mirroring tenant_db_url. Read by pool-registry.ts resolveProjectDsn() as a bridge until a real secret-manager integration exists.';
COMMENT ON COLUMN roadmap.project.display_name IS
  'Human-readable label shown in dashboards; defaults to the slug-derived name.';
