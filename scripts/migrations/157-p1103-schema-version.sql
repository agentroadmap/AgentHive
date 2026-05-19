-- P1103 A1: Schema versioning on message_ledger
--
-- AC: schema_version smallint on message_ledger
--
-- Strategy: Default new rows to 1 (current canonical schema).
-- Future dual-write cutover will bump new rows to 2; existing rows stay at 1
-- until migrated via explicit UPDATE in a later phase.
-- This allows safe rollback during cutover without orphaning live data.
--
-- Idempotent: IF NOT EXISTS clause prevents errors on re-run.

ALTER TABLE IF EXISTS roadmap.message_ledger
ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN roadmap.message_ledger.schema_version IS
  'P1103: Schema version for dual-write cutover. 1 = legacy format, 2+ = future enhanced schemas.';
