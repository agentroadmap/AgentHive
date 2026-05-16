-- P1093: Agent Registry Reaper — periodic prune of stale identity rows
--
-- Adds soft-delete columns (already present in target DB via earlier hot-apply),
-- replaces the stub function with a working soft-delete implementation, and
-- runs a one-time backfill.
--
-- Hard-delete is not viable: agent_registry is the identity anchor for dozens of
-- tables across roadmap*, roadmap_proposal*, roadmap_workforce*, roadmap_efficiency*
-- schemas, many with RESTRICT FK rules. Soft-delete (reaped_at + reap_reason)
-- marks rows as logically gone while preserving referential integrity.
--
-- Expected backfill count at first apply: ~80–100 rows (30-day window).
-- If actual count deviates by >2× investigate before proceeding.

BEGIN;

-- ── 1. Schema: add soft-delete columns (idempotent) ─────────────────────────

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS reaped_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reap_reason TEXT;

-- ── 2. Reaper function (soft-delete) ────────────────────────────────────────
--
-- Marks inactive, long-unseen rows with reaped_at = now().
-- Safety guards:
--   • Never touches status='active' rows (WHERE status='inactive' only).
--   • Skips rows with open leases (released_at IS NULL).
--   • Skips rows with in-flight agent_runs (status IN ('claimed','running')).
--   • Skips rows already reaped (reaped_at IS NOT NULL).
--   • Advisory xact lock (key 1093,1) prevents concurrent runs.
--   • Batched UPDATE with FOR UPDATE SKIP LOCKED avoids contention.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_stale_registry(
  retention_interval INTERVAL,
  batch_size         INT DEFAULT 1000
) RETURNS INT
LANGUAGE plpgsql
AS $fn$
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

  -- One reaper at a time per DB (xact-scoped advisory lock)
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

  RETURN v_total_count;
END;
$fn$;

-- ── 3. One-time backfill (30-day window) ────────────────────────────────────
-- Marks rows that have been inactive for ≥30 days.  Wider window than the
-- daily cron (14d) to avoid reaping rows that went stale during a planned
-- outage right before this migration was applied.

DO $$
DECLARE v_reaped INT;
BEGIN
  SELECT roadmap_workforce.fn_reap_stale_registry('30 days'::interval) INTO v_reaped;
  RAISE NOTICE 'P1093 backfill: reaped % rows (30-day window)', v_reaped;
END;
$$;

COMMIT;
