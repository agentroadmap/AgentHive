-- Migration 144: P404 fix — align fn_reap_orphan_scratch with TypeScript caller
--
-- Migration 181 (scripts/migrations/181-p404-scratch-space.sql) created
-- fn_reap_orphan_scratch() as RETURNS INT + pg_notify. The TypeScript caller
-- in src/core/orchestration/scratch.ts calls it as RETURNS TABLE(run_id TEXT)
-- (iterating rows to call reapScratch per UUID). This mismatch means the
-- orphan batch sweep is silently broken: rows = [{fn_reap_orphan_scratch: N}],
-- row.run_id = undefined, reapScratch throws "Invalid scratch UUID: undefined"
-- (caught, suppressed), nothing gets reaped.
--
-- Fix: replace with the row-returning variant so Node.js cron + boot scan work.
-- The direct reapScratch() path in the spawner's finally block handles normal
-- exits; pg_notify is not needed and is removed from this function.
--
-- Idempotent: DROP + CREATE is safe to re-run (no callers hold a reference
-- longer than a single Node.js query call).

DROP FUNCTION IF EXISTS roadmap_workforce.fn_reap_orphan_scratch();
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_orphan_scratch()
RETURNS TABLE(run_id TEXT) LANGUAGE sql AS $$
  SELECT run_id
  FROM   roadmap_workforce.agent_scratch_dir
  WHERE  reaped_at IS NULL
    AND  expires_at < now()
    AND  (forensic_hold_until IS NULL OR forensic_hold_until < now());
$$;
