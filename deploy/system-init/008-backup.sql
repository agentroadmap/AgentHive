-- ============================================================
-- agentHive2 — 008-backup.sql
-- Backup infrastructure: tenant_backup tracking and retention policy.
-- Logical pg_dump backups are the primary recovery mechanism for v1.
-- WAL archiving / PITR is out of scope; see P895 design.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.tenant_backup — append-only backup audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup (
  backup_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         BIGINT       REFERENCES core.project(id) ON DELETE RESTRICT,
  taken_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  backup_kind        TEXT         NOT NULL
                                 CHECK (backup_kind IN ('full', 'schema')),
  storage_uri        TEXT         NOT NULL,
  size_bytes         BIGINT,
  retention_until    TIMESTAMPTZ  NOT NULL,
  verified_at        TIMESTAMPTZ,
  verification_note  TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.tenant_backup IS
  'Append-only audit log of all backups. Full backups have project_id=NULL. '
  'Schema backups reference a specific project. Immutable once written.';

COMMENT ON COLUMN core.tenant_backup.backup_id IS
  'Unique backup identifier (UUID).';
COMMENT ON COLUMN core.tenant_backup.project_id IS
  'Project (schema) being backed up. NULL for full-DB backups.';
COMMENT ON COLUMN core.tenant_backup.taken_at IS
  'Timestamp when pg_dump completed (before INSERT).';
COMMENT ON COLUMN core.tenant_backup.backup_kind IS
  ''full'' = entire agentHive2 DB; ''schema'' = single project schema dump.';
COMMENT ON COLUMN core.tenant_backup.storage_uri IS
  'File path or URI to the dump file. Format: /var/agenthive/backups/<name>-<date>.dump';
COMMENT ON COLUMN core.tenant_backup.size_bytes IS
  'Compressed dump size in bytes.';
COMMENT ON COLUMN core.tenant_backup.retention_until IS
  'Timestamp after which this backup may be pruned. Set per retention policy.';
COMMENT ON COLUMN core.tenant_backup.verified_at IS
  'Timestamp when restore verification passed (weekly verify cron). NULL until verified.';
COMMENT ON COLUMN core.tenant_backup.verification_note IS
  'Optional note from verify cron (e.g., row counts, smoke test results).';

-- Prevent direct updates or deletes; deny_mutation trigger
CREATE OR REPLACE FUNCTION core.deny_mutation_tenant_backup()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant_backup is append-only: UPDATE and DELETE are forbidden';
END;
$$;

CREATE TRIGGER deny_update_tenant_backup
  BEFORE UPDATE ON core.tenant_backup
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation_tenant_backup();

CREATE TRIGGER deny_delete_tenant_backup
  BEFORE DELETE ON core.tenant_backup
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation_tenant_backup();

-- Index for fast lookup by project
CREATE INDEX IF NOT EXISTS tenant_backup_project_id
  ON core.tenant_backup (project_id) WHERE project_id IS NOT NULL;

-- Index for retention pruning (find stale backups)
CREATE INDEX IF NOT EXISTS tenant_backup_retention_until
  ON core.tenant_backup (retention_until);

-- Index for verification status
CREATE INDEX IF NOT EXISTS tenant_backup_verified_at
  ON core.tenant_backup (verified_at) WHERE verified_at IS NULL;

-- ============================================================
-- core.tenant_backup_policy — per-project backup schedule
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup_policy (
  project_id         BIGINT       PRIMARY KEY REFERENCES core.project(id) ON DELETE CASCADE,
  schedule_cron      TEXT         NOT NULL DEFAULT '0 4 * * *',
  retention_days_daily   INT      NOT NULL DEFAULT 14,
  retention_weeks_weekly INT      NOT NULL DEFAULT 12,
  retention_months_monthly INT    NOT NULL DEFAULT 12,
  target_uri_prefix  TEXT         NOT NULL DEFAULT '/var/agenthive/backups',
  backup_kind        TEXT         NOT NULL DEFAULT 'schema'
                                 CHECK (backup_kind IN ('schema', 'full')),
  enabled            BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.tenant_backup_policy IS
  'Per-project backup schedule and retention rules. Defaults seed for ''agentHive'' project. '
  'Retention policy: keep last N daily, N weekly (Mondays), N monthly (1st of month).';

COMMENT ON COLUMN core.tenant_backup_policy.schedule_cron IS
  'Cron schedule for daily backup. Default: ''0 4 * * *'' (04:00 UTC daily).';
COMMENT ON COLUMN core.tenant_backup_policy.retention_days_daily IS
  'Number of daily backups to retain (default 14 days).';
COMMENT ON COLUMN core.tenant_backup_policy.retention_weeks_weekly IS
  'Number of weekly (Monday) backups to retain (default 12 weeks).';
COMMENT ON COLUMN core.tenant_backup_policy.retention_months_monthly IS
  'Number of monthly (1st-of-month) backups to retain (default 12 months).';
COMMENT ON COLUMN core.tenant_backup_policy.target_uri_prefix IS
  'Base directory for backup files (default /var/agenthive/backups).';
COMMENT ON COLUMN core.tenant_backup_policy.backup_kind IS
  ''schema'' = dump only the project schema; ''full'' = entire DB. Default ''schema''.';
COMMENT ON COLUMN core.tenant_backup_policy.enabled IS
  'If false, skip this project in daily backup cron.';

CREATE TRIGGER set_updated_at_tenant_backup_policy
  BEFORE UPDATE ON core.tenant_backup_policy
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ============================================================
-- Seed default policy for 'agentHive' project
-- ============================================================
INSERT INTO core.tenant_backup_policy (
  project_id,
  schedule_cron,
  retention_days_daily,
  retention_weeks_weekly,
  retention_months_monthly,
  backup_kind,
  enabled
) SELECT
  id,
  '0 4 * * *',
  14,
  12,
  12,
  'schema',
  true
FROM core.project
WHERE slug = 'agentHive'
ON CONFLICT DO NOTHING;
