-- P837: Restore 'liaison' to message_ledger_type_check
--
-- Migration 097 added 'liaison' to message_ledger_type_check so that
-- liaison-message-service.ts can mirror liaison_message rows to the
-- unified message_ledger bus. Migration 116 (P856) replaced the
-- constraint to add protocol_ping/pong but omitted 'liaison', causing
-- the mirror to fail silently on every storeMessage() call.
--
-- This migration restores 'liaison' alongside the P856 types.

BEGIN;

ALTER TABLE roadmap.message_ledger
    DROP CONSTRAINT IF EXISTS message_ledger_type_check;

ALTER TABLE roadmap.message_ledger
    ADD CONSTRAINT message_ledger_type_check
    CHECK (message_type = ANY (ARRAY[
        'text'::text,
        'task'::text,
        'notify'::text,
        'ack'::text,
        'error'::text,
        'event'::text,
        'liaison'::text,
        'protocol_ping'::text,
        'protocol_pong'::text
    ]));

COMMIT;
