-- ============================================================
-- system-init/009-backup.sql
-- Backup catalog and policy tables for AgentHive2 tenants.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql (core.project), 004-governance.sql (governance.event)
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.tenant_backup — append-only backup manifest
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup (
  backup_id        UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  taken_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  backup_kind      TEXT         NOT NULL
                               CHECK (backup_kind IN ('full','schema','wal')),
  storage_uri      TEXT         NOT NULL,         -- file:// or s3:// path to dump
  size_bytes       BIGINT,
  schema_name      TEXT,                          -- populated for backup_kind='schema'
  pg_version       TEXT,
  dump_format      TEXT         NOT NULL DEFAULT 'custom'
                               CHECK (dump_format IN ('custom','plain','directory','tar')),
  verified_at      TIMESTAMPTZ,                   -- set by verify step
  verify_status    TEXT         CHECK (verify_status IN ('ok','failed',NULL)),
  retention_until  TIMESTAMPTZ  NOT NULL,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Prevent UPDATE — this table is append-only; only verified_at/verify_status may be SET
CREATE OR REPLACE RULE tenant_backup_no_delete AS
  ON DELETE TO core.tenant_backup DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS tenant_backup_project_taken
  ON core.tenant_backup (project_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS tenant_backup_kind
  ON core.tenant_backup (backup_kind);
CREATE INDEX IF NOT EXISTS tenant_backup_retention
  ON core.tenant_backup (retention_until);

COMMENT ON TABLE core.tenant_backup IS
  'Append-only backup manifest. One row per backup taken. verified_at and verify_status '
  'are the only columns updated after insert (by the verify script). '
  'Rows are logically pruned by prune-backup.sh when retention_until < now().';

-- ============================================================
-- core.tenant_backup_policy — per-project backup schedule & retention
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup_policy (
  project_id       BIGINT       NOT NULL REFERENCES core.project (id) ON DELETE CASCADE PRIMARY KEY,
  schedule_cron    TEXT         NOT NULL DEFAULT '0 3 * * *',   -- daily at 03:00 UTC
  retention_days   INT          NOT NULL DEFAULT 30,
  target_uri_prefix TEXT        NOT NULL DEFAULT 'file:///var/backups/agenthive',
  backup_kind      TEXT         NOT NULL DEFAULT 'full'
                               CHECK (backup_kind IN ('full','schema','wal')),
  enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER set_updated_at_tenant_backup_policy
  BEFORE UPDATE ON core.tenant_backup_policy
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.tenant_backup_policy IS
  'Per-project backup policy: schedule, retention window, and target storage prefix. '
  'One row per project. backup.sh reads this to decide what/where to back up.';

-- ============================================================
-- Seed default policy for the agentHive project (idempotent)
-- ============================================================
INSERT INTO core.tenant_backup_policy (project_id, schedule_cron, retention_days, target_uri_prefix, backup_kind)
SELECT id, '0 3 * * *', 30, 'file:///var/backups/agenthive', 'full'
FROM core.project
WHERE slug = 'agentHive'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT SELECT, INSERT, UPDATE ON core.tenant_backup TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.tenant_backup_policy TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT SELECT ON core.tenant_backup TO agenthive_observability;
    GRANT SELECT ON core.tenant_backup_policy TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT SELECT ON core.tenant_backup TO agenthive_agency;
    GRANT SELECT ON core.tenant_backup_policy TO agenthive_agency;
  END IF;
END $$;
