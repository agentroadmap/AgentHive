-- P523: Unified Feature Flag System — Schema, Triggers, and Hot-Reload
-- Provides DB-backed, hot-reloadable feature flags with per-tenant scoping and audit trail.

-- Create primary feature flag registry table
CREATE TABLE IF NOT EXISTS roadmap.feature_flag (
  flag_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  enabled_default BOOLEAN NOT NULL DEFAULT false,
  per_tenant_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollout_percent INTEGER NOT NULL DEFAULT 100
    CONSTRAINT ck_rollout_percent CHECK (rollout_percent >= 0 AND rollout_percent <= 100),
  variant_values JSONB DEFAULT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT false
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_feature_flag_updated_at
  ON roadmap.feature_flag(updated_at);
CREATE INDEX IF NOT EXISTS idx_feature_flag_archived
  ON roadmap.feature_flag(is_archived) WHERE NOT is_archived;

-- Create immutable audit log table
CREATE TABLE IF NOT EXISTS roadmap.feature_flag_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name TEXT NOT NULL REFERENCES roadmap.feature_flag(flag_name) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  reason TEXT,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_flag
  ON roadmap.feature_flag_audit(flag_name);
CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_changed_at
  ON roadmap.feature_flag_audit(changed_at);
CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_changed_by
  ON roadmap.feature_flag_audit(changed_by);

-- Hot-reload trigger function
CREATE OR REPLACE FUNCTION roadmap.trigger_feature_flag_notify() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'feature_flag_changed',
    json_build_object(
      'action', TG_OP,
      'flag_name', NEW.flag_name,
      'enabled_default', NEW.enabled_default,
      'per_tenant_override', NEW.per_tenant_override,
      'rollout_percent', NEW.rollout_percent,
      'variant_values', NEW.variant_values,
      'updated_at', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create or replace trigger for hot-reload notifications
DROP TRIGGER IF EXISTS trg_feature_flag_notify ON roadmap.feature_flag;
CREATE TRIGGER trg_feature_flag_notify
  AFTER INSERT OR UPDATE ON roadmap.feature_flag
  FOR EACH ROW
  EXECUTE FUNCTION roadmap.trigger_feature_flag_notify();
