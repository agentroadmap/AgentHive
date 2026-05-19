-- env: prod
-- Migration 120: P753 follow-up — drop orphan plpgsql functions that
-- still body-reference the retired roadmap.transition_queue table.
--
-- Background:
--   Migration 118 dropped roadmap.transition_queue CASCADE. CASCADE drops
--   triggers on the table but does NOT drop standalone plpgsql functions
--   whose bodies SELECT/UPDATE the table — Postgres late-binds SQL inside
--   plpgsql, so the function definition is preserved and only fails at
--   call time. Two such functions remain:
--
--   1. roadmap.fn_mark_transition_done(bigint, jsonb)
--      Defined in scripts/migrations/020-fix-gate-pipeline.sql. Body:
--      `UPDATE roadmap.transition_queue SET status='done' WHERE id=...`
--      Zero callers in src/, scripts/, tests/, database/ as of P902-A
--      cutover (commit da31d48d). Safe to drop.
--
--   2. roadmap.fn_guard_transition_queue_done()
--      Defined in scripts/migrations/029-transition-queue-completion-guard.sql
--      as the BEFORE UPDATE trigger function for trg_guard_transition_queue_done.
--      The trigger was dropped by mig 118's CASCADE; the function survived
--      because plpgsql functions are not table dependents in Postgres'
--      cascade graph. Zero call sites.
--
-- Effect:
--   - DROP FUNCTION IF EXISTS — idempotent, safe to re-run.
--   - No data touched (these are pure code objects).
--
-- Rollback: restore from scripts/migrations/020-fix-gate-pipeline.sql for
-- fn_mark_transition_done and scripts/migrations/029-transition-queue-completion-guard.sql
-- for fn_guard_transition_queue_done. But also restore mig 118 rollback
-- first since both functions are useless without the table.

BEGIN;

DROP FUNCTION IF EXISTS roadmap.fn_mark_transition_done(bigint, jsonb);
DROP FUNCTION IF EXISTS roadmap.fn_guard_transition_queue_done();

COMMIT;
