-- Rollback for 317-p4664-lock-noncanonical-ledger.sql (P4664-AC-4)
--
-- Removes the statement-level readonly guard added by migration 317 and restores
-- write privileges to application roles. The P4625 row-level readonly trigger
-- (trg_migration_history_readonly) is INTENTIONALLY left in place — it predates
-- P4664 and is not owned by this migration.
--
-- Idempotent: safe to run more than once.

BEGIN;

DROP TRIGGER IF EXISTS trg_migration_history_readonly_stmt
  ON roadmap.migration_history;

DROP FUNCTION IF EXISTS roadmap.fn_migration_history_readonly_stmt();

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'agent_write', 'roadmap_agent',
    'ac_agency', 'ac_orchestrator', 'ac_observability',
    'agenthive_agency', 'agenthive_orchestrator', 'agenthive_observability',
    'agenthive_a2a', 'admin_write'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'GRANT INSERT, UPDATE, DELETE ON roadmap.migration_history TO %s',
        quote_ident(r)
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;
