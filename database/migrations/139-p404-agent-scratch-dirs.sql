-- P404: Agent Scratch Space Management & Auto-Reaper
-- Creates agent_scratch_dir table, adds cubics.scratch_path column,
-- seeds app_config scratch.* keys, and adds DB helper for orphan detection.
-- NO pg_cron: reaper runs via Node.js cron (scripts/cubic-lifecycle-cron.ts).

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_scratch_dir (
  run_id              TEXT PRIMARY KEY
    CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  agent_run_id        BIGINT REFERENCES roadmap_workforce.agent_runs(id) ON DELETE SET NULL,
  agent_identity      TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '4 hours'
    CHECK (expires_at <= now() + INTERVAL '24 hours' + INTERVAL '5 minutes'),
  forensic_hold_until TIMESTAMPTZ,
  reaped_at           TIMESTAMPTZ,
  reap_error          TEXT,
  size_mb_at_reap     NUMERIC(10,2)
);

CREATE INDEX IF NOT EXISTS idx_scratch_dir_unreaped
  ON roadmap_workforce.agent_scratch_dir (expires_at)
  WHERE reaped_at IS NULL;

-- ── cubics extension ──────────────────────────────────────────────────────────

ALTER TABLE roadmap.cubics ADD COLUMN IF NOT EXISTS scratch_path TEXT;

-- ── Configuration seeds ───────────────────────────────────────────────────────

INSERT INTO roadmap.app_config (config_key, config_value, config_category, description)
VALUES
  ('scratch.max_age_hours',      '4',    'scratch', 'Default scratch directory TTL in hours (max 24)'),
  ('scratch.forensic_max_hours', '24',   'scratch', 'Forensic hold window in hours (hard cap)'),
  ('scratch.max_size_mb',        '1024', 'scratch', 'Soft size limit per scratch dir in MB (logged, not enforced)'),
  ('scratch.reaper_interval_min','15',   'scratch', 'Orphan reaper sweep interval in minutes (matches cron cadence)')
ON CONFLICT (config_key) DO NOTHING;

-- ── Orphan-detection helper (called by Node.js cron, not pg_cron) ─────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_orphan_scratch()
RETURNS TABLE(run_id TEXT) LANGUAGE sql AS $$
  SELECT run_id
  FROM   roadmap_workforce.agent_scratch_dir
  WHERE  reaped_at IS NULL
    AND  expires_at < now()
    AND  (forensic_hold_until IS NULL OR forensic_hold_until < now());
$$;
