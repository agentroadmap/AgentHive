-- P856: Add 'protocol_ping' and 'protocol_pong' to message_ledger_type_check.
--
-- The agent-liveness probe (src/core/orchestration/probes/agent-liveness.ts)
-- inserts a 'protocol_ping' row and the liaison replies with 'protocol_pong'.
-- The pre-existing CHECK constraint only allowed
-- {text, task, notify, ack, error, event} so every probe attempt failed
-- with SQLSTATE 23514.
--
-- These two kinds are explicitly defined in P468's 21-kind protocol catalog.
-- They are control-plane messages, not content; LLM handlers must ignore them
-- and reply via the protocol_pong fast-path (see start-claude-code-agency.ts).

BEGIN;

ALTER TABLE roadmap.message_ledger
    DROP CONSTRAINT IF EXISTS message_ledger_type_check;

ALTER TABLE roadmap.message_ledger
    ADD  CONSTRAINT message_ledger_type_check
    CHECK (message_type = ANY (ARRAY[
        'text'::text,
        'task'::text,
        'notify'::text,
        'ack'::text,
        'error'::text,
        'event'::text,
        'protocol_ping'::text,
        'protocol_pong'::text
    ]));

COMMIT;
