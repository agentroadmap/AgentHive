-- P1105: Add 'user_message' to message_ledger_type_check
--
-- Extends the message_type CHECK constraint to allow 'user_message',
-- required for USER first-class agent identity (AC-2).

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
        'protocol_pong'::text,
        'task_request'::text,
        'task_ack'::text,
        'task_error'::text,
        'task_status'::text,
        'user_message'::text
    ]));

COMMIT;
