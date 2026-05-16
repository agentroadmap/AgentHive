-- P509: Tenant DB ops bundle — backup catalog + disk cap config tables.
-- Depends on roadmap.project (exists since multi-tenancy foundation).
-- Idempotent: all DDL uses CREATE TABLE IF NOT EXISTS.

-- Backup catalog: one row per completed pg_dump.
CREATE TABLE IF NOT EXISTS roadmap.tenant_backup (
  backup_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         BIGINT       NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  taken_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  backup_kind        TEXT         NOT NULL DEFAULT 'logical',
  storage_uri        TEXT         NOT NULL,
  size_bytes         BIGINT,
  checksum_sha256    TEXT,
  manifest_lines     INT,
  retention_until    TIMESTAMPTZ  NOT NULL,
  verified_at        TIMESTAMPTZ,
  verify_tables      INT,
  verify_failed      INT,
  CONSTRAINT tenant_backup_kind_check CHECK (backup_kind IN ('logical', 'physical', 'snapshot'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_backup_project_taken
  ON roadmap.tenant_backup (project_id, taken_at DESC);

COMMENT ON TABLE roadmap.tenant_backup IS
  'Catalog of per-tenant pg_dump backups (P509). '
  'storage_uri = local path (file://) or S3 URI. '
  'verified_at is set by the monthly restore-test job. '
  'verify_tables/verify_failed count public-schema table validations.';

-- Per-tenant disk cap and retention policy.
-- Populated by provisioning; updated via ops runbook.
CREATE TABLE IF NOT EXISTS roadmap.tenant_backup_policy (
  project_id          BIGINT  PRIMARY KEY REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  disk_cap_gb         INT     NOT NULL DEFAULT 50,
  retain_daily_days   INT     NOT NULL DEFAULT 14,
  retain_weekly_count INT     NOT NULL DEFAULT 8,
  retain_monthly_count INT    NOT NULL DEFAULT 12,
  backup_cron_expr    TEXT    NOT NULL DEFAULT '15 3 * * *',
  prune_cron_expr     TEXT    NOT NULL DEFAULT '0 5 * * *',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.tenant_backup_policy IS
  'Per-tenant disk budget and backup retention settings (P509). '
  'Seeded with safe defaults; update via ops runbook when tenant tier changes. '
  'disk_cap_gb is a hard cap enforced by the prune script before retention pruning.';

-- Seed default policy for the agenthive project (project_id=1).
INSERT INTO roadmap.tenant_backup_policy (project_id)
SELECT project_id FROM roadmap.project WHERE project_id = 1
ON CONFLICT (project_id) DO NOTHING;
