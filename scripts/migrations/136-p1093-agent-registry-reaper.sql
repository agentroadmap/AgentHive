-- P1093: Agent Registry Reaper
--
-- Adds stale-row pruning for roadmap_workforce.agent_registry.
-- The function hard-deletes inactive registry rows only after the retention
-- window and only when no open proposal lease or in-flight run references the
-- identity. Each deleted batch is audited in roadmap.agent_lifecycle_log.

BEGIN;

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reaped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reap_reason TEXT;

UPDATE roadmap_workforce.agent_registry
   SET last_seen_at = COALESCE(updated_at, created_at, now())
 WHERE last_seen_at IS NULL;

COMMENT ON COLUMN roadmap_workforce.agent_registry.last_seen_at IS
  'Last observed activity for registry retention. Backfilled from updated_at/created_at for pre-P1093 rows.';
COMMENT ON COLUMN roadmap_workforce.agent_registry.reaped_at IS
  'Optional tombstone timestamp for soft-delete retention flows; hard-delete reaper paths do not populate it.';
COMMENT ON COLUMN roadmap_workforce.agent_registry.reap_reason IS
  'Optional tombstone reason for soft-delete retention flows; hard-delete reaper paths do not populate it.';

CREATE INDEX IF NOT EXISTS idx_agent_registry_inactive_last_seen
  ON roadmap_workforce.agent_registry (last_seen_at, id)
  WHERE status = 'inactive';

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_stale_registry(
  retention_interval INTERVAL,
  batch_size INT DEFAULT 1000
)
RETURNS INT
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

  IF NOT pg_try_advisory_xact_lock(1093, 1) THEN
    RETURN 0;
  END IF;

  LOOP
    WITH candidates AS (
      SELECT ar.id
      FROM roadmap_workforce.agent_registry ar
      WHERE ar.status = 'inactive'
        AND ar.last_seen_at < now() - retention_interval
        AND NOT EXISTS (
          SELECT 1
          FROM roadmap_proposal.proposal_lease pl
          WHERE pl.agent_identity = ar.agent_identity
            AND pl.released_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM roadmap_workforce.agent_runs r
          WHERE r.agent_identity = ar.agent_identity
            AND r.status IN ('claimed', 'running')
        )
      ORDER BY ar.last_seen_at ASC, ar.id ASC
      FOR UPDATE OF ar SKIP LOCKED
      LIMIT batch_size
    ),
    deleted AS (
      DELETE FROM roadmap_workforce.agent_registry ar
      USING candidates c
      WHERE ar.id = c.id
      RETURNING ar.id
    )
    SELECT COUNT(*)::INT INTO v_batch_count
    FROM deleted;

    EXIT WHEN v_batch_count = 0;

    v_total_count := v_total_count + v_batch_count;

    INSERT INTO roadmap.agent_lifecycle_log (agency_id, event_type, details)
    VALUES (
      'system/registry-reaper',
      'registry_reap',
      jsonb_build_object(
        'count', v_batch_count,
        'retention', retention_interval::text,
        'batch_size', batch_size
      )
    );

    PERFORM pg_notify(
      'agent_lifecycle_events',
      json_build_object(
        'event_type', 'registry_reap',
        'agency_id', 'system/registry-reaper',
        'count', v_batch_count,
        'retention', retention_interval::text,
        'batch_size', batch_size
      )::text
    );
  END LOOP;

  RETURN v_total_count;
END;
$fn$;

COMMENT ON FUNCTION roadmap_workforce.fn_reap_stale_registry(INTERVAL, INT) IS
  'P1093: hard-deletes inactive agent_registry rows older than retention while protecting active leases and in-flight runs.';

COMMIT;
