-- Migration 128: P1093 — Agent Registry Reaper
--
-- Adds soft-delete tombstone columns to agent_registry and a batched
-- fn_reap_stale_registry() function that marks inactive rows as reaped
-- without hard-deleting them. A daily cron at 03:00 UTC drives the
-- function; the one-time backfill at the bottom clears the existing
-- 8 500+ stale rows on first apply.
--
-- Safety guarantees baked into the function:
--   • Never marks status='active' rows regardless of last_seen_at.
--   • Never marks rows with an open proposal_lease (released_at IS NULL).
--   • Never marks rows with agent_runs in 'claimed' or 'running' state.
--   • Per-call pg_try_advisory_xact_lock prevents concurrent reapers.
--
-- Retention policy: 14d (cron), 30d (backfill). An agency that goes
-- dormant over a multi-day deploy should not lose its identity row.

BEGIN;

-- ── 1. Tombstone columns ──────────────────────────────────────────────────────

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reaped_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reap_reason   TEXT;

COMMENT ON COLUMN roadmap_workforce.agent_registry.last_seen_at IS
  'UTC timestamp of the last heartbeat / re-registration. NULL means the row predates P1093.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.reaped_at IS
  'UTC timestamp set by fn_reap_stale_registry when the row is soft-deleted. NULL = live row.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.reap_reason IS
  'Human-readable reason written by fn_reap_stale_registry, e.g. "stale_reaper retention=14 days".';

-- ── 2. Reaper function ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_stale_registry(
  retention_interval INTERVAL,
  batch_size         INT DEFAULT 1000
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $function$
DECLARE
  v_batch_count INT := 0;
  v_total_count INT := 0;
BEGIN
  IF retention_interval IS NULL OR retention_interval <= interval '0 seconds' THEN
    RAISE EXCEPTION 'retention_interval must be positive'
      USING ERRCODE = '22023';
  END IF;

  IF batch_size IS NULL OR batch_size <= 0 THEN
    RAISE EXCEPTION 'batch_size must be positive'
      USING ERRCODE = '22023';
  END IF;

  -- Advisory lock (transaction-scoped) prevents two concurrent reapers.
  -- Lock key: (1093, 1) — proposal number + sub-key.
  IF NOT pg_try_advisory_xact_lock(1093, 1) THEN
    RETURN 0;
  END IF;

  LOOP
    WITH candidates AS (
      SELECT ar.id
      FROM   roadmap_workforce.agent_registry ar
      WHERE  ar.status        = 'inactive'
        AND  ar.last_seen_at  < now() - retention_interval
        AND  ar.reaped_at    IS NULL
        AND  NOT EXISTS (
          SELECT 1
          FROM   roadmap_proposal.proposal_lease pl
          WHERE  pl.agent_identity = ar.agent_identity
            AND  pl.released_at   IS NULL
        )
        AND  NOT EXISTS (
          SELECT 1
          FROM   roadmap_workforce.agent_runs r
          WHERE  r.agent_identity = ar.agent_identity
            AND  r.status IN ('claimed', 'running')
        )
      ORDER BY ar.last_seen_at ASC, ar.id ASC
      FOR UPDATE OF ar SKIP LOCKED
      LIMIT batch_size
    ),
    reaped AS (
      UPDATE roadmap_workforce.agent_registry ar
      SET    reaped_at   = now(),
             reap_reason = format('stale_reaper retention=%s', retention_interval::text)
      FROM   candidates c
      WHERE  ar.id = c.id
      RETURNING ar.id
    )
    SELECT COUNT(*)::INT INTO v_batch_count FROM reaped;

    EXIT WHEN v_batch_count = 0;

    v_total_count := v_total_count + v_batch_count;

    INSERT INTO roadmap.agent_lifecycle_log (agency_id, event_type, details)
    VALUES (
      'system/registry-reaper',
      'registry_reap',
      jsonb_build_object(
        'count',      v_batch_count,
        'retention',  retention_interval::text,
        'batch_size', batch_size
      )
    );

    PERFORM pg_notify(
      'agent_lifecycle_events',
      json_build_object(
        'event_type', 'registry_reap',
        'agency_id',  'system/registry-reaper',
        'count',      v_batch_count,
        'retention',  retention_interval::text,
        'batch_size', batch_size
      )::text
    );
  END LOOP;

  -- Targeted ANALYZE after a large reap so the planner sees updated stats.
  IF v_total_count > 500 THEN
    ANALYZE roadmap_workforce.agent_registry;
  END IF;

  RETURN v_total_count;
END;
$function$;

COMMENT ON FUNCTION roadmap_workforce.fn_reap_stale_registry(INTERVAL, INT) IS
  'P1093: Soft-delete inactive agent_registry rows older than retention_interval.
   Batched to avoid lock storms. Advisory-locked to prevent concurrent runs.
   Writes a registry_reap event to agent_lifecycle_log per batch.
   Returns total rows reaped (0 if lock could not be acquired).';

-- ── 3. Index for reaper candidate scan ───────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_agent_registry_reap_candidates
  ON roadmap_workforce.agent_registry (last_seen_at ASC, id ASC)
  WHERE status = 'inactive' AND reaped_at IS NULL;

-- ── 4. One-time backfill ──────────────────────────────────────────────────────
-- Expected to reap ~8 500 rows on first apply; harmless no-op on re-apply.
-- A significant delta from expected (e.g. < 100 or > 20 000) warrants
-- investigation before marking this migration as complete.

DO $$
DECLARE
  v_reaped INT;
BEGIN
  SELECT roadmap_workforce.fn_reap_stale_registry('30 days'::interval) INTO v_reaped;
  RAISE NOTICE 'P1093 backfill: reaped % rows (expected ~8500)', v_reaped;
END;
$$;

COMMIT;
