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

-- ── 2. agent_lifecycle_log constraint check (AC-2) ──────────────────────────
-- agent_lifecycle_log.event_type has NO CHECK constraint (confirmed by
-- information_schema query at migration write time). No extension needed;
-- 'registry_reap' is a valid free-form value.

-- ── 3. Reaper function (soft-delete) ────────────────────────────────────────
--
-- Marks inactive, long-unseen rows with reaped_at = now().
-- Safety guards:
--   • Never touches status='active' rows (WHERE status='inactive' only).
--   • Skips rows with open leases (released_at IS NULL).
--   • Skips rows with in-flight agent_runs (status IN ('claimed','running')).
--   • Skips rows already reaped (reaped_at IS NOT NULL).
--   • Advisory xact lock (key 1093,1) prevents concurrent runs.
--   • Batched UPDATE with FOR UPDATE SKIP LOCKED avoids contention.
--   • Calls ANALYZE after large-batch runs (>500 rows) to keep planner stats
--     fresh (AC-12).

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

  -- AC-12: refresh planner stats after large-batch runs so query plans stay
  -- accurate as the working set shrinks.
  IF v_total_count > 500 THEN
    ANALYZE roadmap_workforce.agent_registry;
  END IF;

  RETURN v_total_count;
END;
$fn$;

-- ── 4. One-time backfill (30-day window) ────────────────────────────────────
-- Marks rows inactive for ≥30 days. Wider window than the daily cron (14d).
-- Expected count at first apply: ~0–100 (most stale rows are 14–29 days old).
-- If actual count > 200, investigate for unexpected identity churn.

DO $$
DECLARE v_reaped INT;
BEGIN
  SELECT roadmap_workforce.fn_reap_stale_registry('30 days'::interval) INTO v_reaped;
  RAISE NOTICE 'P1093 backfill: reaped % rows (30-day window)', v_reaped;
  IF v_reaped > 200 THEN
    RAISE WARNING 'P1093 backfill: % rows > expected ceiling of 200 — investigate identity churn', v_reaped;
  END IF;
END;
$$;

-- ── 5. Post-backfill verification (AC-7, revised for soft-delete) ────────────
-- Soft-delete keeps rows in the table; the meaningful metric is unreaped stale
-- rows (eligible for future cron runs), not total inactive count.
-- After this migration + the 14d cron run, unreaped-stale should be 0.

DO $$
DECLARE v_unreaped_stale INT;
BEGIN
  SELECT COUNT(*)::INT INTO v_unreaped_stale
  FROM   roadmap_workforce.agent_registry
  WHERE  status       = 'inactive'
    AND  reaped_at   IS NULL
    AND  last_seen_at < now() - interval '30 days';

  RAISE NOTICE 'P1093 post-backfill: % unreaped-stale rows (>30d, not yet reaped)', v_unreaped_stale;
  IF v_unreaped_stale > 0 THEN
    RAISE WARNING 'P1093: % unreaped stale rows remain after backfill — reaper may have been locked out', v_unreaped_stale;
  END IF;
END;
$$;

COMMIT;
