-- Migration 317 — P4664: Lock the NON-canonical migration ledger
--
-- Canonical decision (P4664, see CONVENTIONS.md §6.x):
--   roadmap.schema_migration  = THE canonical migration ledger (written by
--                               scripts/migrate.ts; live writer; 362 rows).
--   roadmap.migration_history = RETIRED / non-canonical. Locked read-only.
--
-- AC-4: a direct INSERT into the non-canonical ledger table must fail with a
--       permission-denied error or a trigger rejection so that only the
--       canonical path can ever write migration-tracking rows.
--
-- P4625 already installed a FOR EACH ROW readonly trigger
-- (trg_migration_history_readonly → fn_migration_history_readonly). This
-- migration hardens that with defense-in-depth:
--   1. A STATEMENT-level guard so even a zero-row INSERT / TRUNCATE is rejected
--      (FOR EACH ROW triggers do not fire when no rows are affected).
--   2. REVOKE of all write privileges (INSERT/UPDATE/DELETE/TRUNCATE) from every
--      application role, so the failure surfaces as permission-denied before the
--      trigger even runs, for any role other than the table owner.
--
-- ⚠ DO NOT APPLY TO LIVE as part of P4664 development. This is delivered as a
-- migration file only; it is applied through the canonical migrate.ts path in a
-- maintenance window. Rollback: scripts/migrations/rollback/317-p4664-lock-noncanonical-ledger.rollback.sql
--
-- Idempotent: safe to run more than once.

BEGIN;

-- 1. Statement-level readonly guard (complements the existing row-level trigger).
CREATE OR REPLACE FUNCTION roadmap.fn_migration_history_readonly_stmt()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'roadmap.migration_history is RETIRED and read-only (P4664-AC-4). '
    'The canonical migration ledger is roadmap.schema_migration; write to it '
    'only via scripts/migrate.ts.'
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_migration_history_readonly_stmt
  ON roadmap.migration_history;

CREATE TRIGGER trg_migration_history_readonly_stmt
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON roadmap.migration_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION roadmap.fn_migration_history_readonly_stmt();

-- 2. Revoke write privileges from every application role so a direct INSERT
--    fails with permission-denied (42501) before any trigger evaluates.
--    SELECT is preserved (the table remains a historical reference).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'PUBLIC',
    'agent_write', 'agent_read', 'roadmap_agent',
    'ac_agency', 'ac_orchestrator', 'ac_observability',
    'agenthive_agency', 'agenthive_orchestrator', 'agenthive_observability',
    'agenthive_a2a', 'admin_write'
  ]
  LOOP
    -- Skip roles that do not exist in this environment.
    IF r = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON roadmap.migration_history FROM %s',
        CASE WHEN r = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
