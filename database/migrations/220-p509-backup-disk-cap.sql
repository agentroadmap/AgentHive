-- P509: Backup disk cap enforcement — ensure column exists.
-- Part of P509 tenant DB ops bundle (post-P895 instrumentation).
-- Idempotent: uses ALTER TABLE IF NOT EXISTS alternative.

-- Add disk_cap_gb column to tenant_backup_policy if missing.
-- (Migration 120 created the table; this ensures column exists for ops enforcement.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap'
      AND table_name = 'tenant_backup_policy'
      AND column_name = 'disk_cap_gb'
  ) THEN
    ALTER TABLE roadmap.tenant_backup_policy
      ADD COLUMN disk_cap_gb INT NOT NULL DEFAULT 50;
    RAISE NOTICE 'Added disk_cap_gb column to tenant_backup_policy';
  ELSE
    RAISE NOTICE 'disk_cap_gb column already exists on tenant_backup_policy';
  END IF;
END $$;

-- Ensure index on backup_cron_expr for provisioning lookups
CREATE INDEX IF NOT EXISTS idx_tenant_backup_policy_project_id
  ON roadmap.tenant_backup_policy (project_id);
