-- P1438 C6 AC-17: add the three liaison↔liaison coordination verbs to the
-- message_ledger message_type CHECK constraint:
--   capacity_query, handoff_request, capability_gap.
--
-- Also reconciles the constraint with the LIVE set + the TS taxonomy
-- (src/infra/messaging/types.ts), which had drifted:
--   * live had 'user_message' (mig 135) and 'throttle_decision' (P1376) but the
--     code routes on 'task_complete' (liaison-agent.ts, task-dispatcher.ts) which
--     was NOT in the CHECK — a latent insert-failure. Add it here.
-- After this migration the CHECK and MESSAGE_TYPES are a single 19-value set;
-- scripts/check-message-type-drift.ts verifies parity.

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
        'task_status'::text,
        'task_complete'::text,
        'task_error'::text,
        'user_message'::text,
        'throttle_decision'::text,
        'capacity_query'::text,
        'handoff_request'::text,
        'capability_gap'::text
    ]));

COMMIT;
