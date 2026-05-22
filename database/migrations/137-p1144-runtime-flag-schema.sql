-- P1144: core.runtime_flag schema alignment.
--
-- The table was created by migration 170-p1132-a2a-host-runtime-flags.sql
-- and the schema was aligned (name→flag_name, scope, lifecycle_status columns added,
-- trigger updated to fire runtime_flag_changed) by
-- migration 174-task40-runtime-flag-resolver-alignment.sql.
--
-- This migration is idempotent: it ensures the schema and index are present
-- without duplicating trigger infrastructure that already exists.

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

-- Table and trigger were created by migrations 170+174.
-- The index below is idempotent; 174 may have already created it.
CREATE INDEX IF NOT EXISTS idx_runtime_flag_active
    ON core.runtime_flag (flag_name, scope)
    WHERE lifecycle_status = 'active';

COMMIT;
