-- Migration 181: P404 Agent Scratch Space Management & Auto-Reaper
--
-- Creates the agent_scratch_dir registry, adds scratch_path to cubics,
-- seeds roadmap.config scratch.* keys, and registers the pg_cron reaper.
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING throughout).
--
-- Canonical location: scripts/migrations/181-p404-scratch-space.sql
-- (database/migrations/120-p404-scratch-space.sql is the original draft; this
-- file is the runner-tracked authoritative version.)

-- ── 1. roadmap.config table (generic key-value config store) ─────────────────
CREATE TABLE IF NOT EXISTS roadmap.config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Seed scratch configuration defaults ───────────────────────────────────
INSERT INTO roadmap.config (key, value, description) VALUES
    ('scratch.max_age_hours',       '4',    'Default scratch dir expiry in hours (max 24)'),
    ('scratch.forensic_max_hours',  '24',   'Max forensic hold duration in hours'),
    ('scratch.max_size_mb',         '1024', 'Soft size limit for scratch dirs (MB); logged but not enforced at runtime'),
    ('scratch.reaper_interval_min', '15',   'pg_cron reaper frequency in minutes')
ON CONFLICT (key) DO NOTHING;

-- ── 3. agent_scratch_dir registry ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_scratch_dir (
    run_id              TEXT PRIMARY KEY
        CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    agent_run_id        BIGINT REFERENCES roadmap_workforce.agent_runs(id) ON DELETE SET NULL,
    agent_identity      TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT now() + interval '4 hours'
        CHECK (expires_at <= now() + interval '24 hours' + interval '5 minutes'),
    forensic_hold_until TIMESTAMPTZ,
    reaped_at           TIMESTAMPTZ,
    reap_error          TEXT,
    size_mb_at_reap     NUMERIC(10,2)
);

CREATE INDEX IF NOT EXISTS idx_scratch_dir_unreaped
    ON roadmap_workforce.agent_scratch_dir (expires_at)
    WHERE reaped_at IS NULL;

-- ── 4. Add scratch_path column to roadmap.cubics ─────────────────────────────
ALTER TABLE roadmap.cubics ADD COLUMN IF NOT EXISTS scratch_path TEXT;

-- ── 5. pg_notify bridge function for orphan reaping ──────────────────────────
-- Emits a pg_notify('reap_scratch', run_id) for every expired unreaped row.
-- The Node.js listener (or boot-time scan) performs the actual fs.rm.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_orphan_scratch()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    v_row   RECORD;
    v_count INT := 0;
BEGIN
    FOR v_row IN
        SELECT run_id
        FROM   roadmap_workforce.agent_scratch_dir
        WHERE  reaped_at IS NULL
          AND  expires_at < now()
          AND  (forensic_hold_until IS NULL OR forensic_hold_until < now())
    LOOP
        PERFORM pg_notify('reap_scratch', v_row.run_id);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

-- ── 6. Register pg_cron job (no-op if cron extension absent) ─────────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) THEN
        PERFORM cron.schedule(
            'reap-orphan-scratch',
            '*/15 * * * *',
            'SELECT roadmap_workforce.fn_reap_orphan_scratch()'
        );
    END IF;
EXCEPTION WHEN others THEN
    -- cron.schedule may error if job name already exists; ignore
    NULL;
END $$;
