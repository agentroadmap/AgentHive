-- Migration 104: add ledger_id to liaison_message
-- liaison-message-service.ts mirrors every message to message_ledger then stores the
-- returned id as ledger_id for cross-surface querying.  The column was added to the
-- service code but never landed in the schema, causing a 42703 column-not-found error
-- on every dispatch.  ledger_id is NULLABLE because the mirror is best-effort.

ALTER TABLE roadmap.liaison_message
    ADD COLUMN IF NOT EXISTS ledger_id BIGINT NULL
        REFERENCES roadmap.message_ledger(id) ON DELETE SET NULL;
