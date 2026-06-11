-- Migration 139: P900 — Persist escalation_failure_count in message_timeout_tracking
--
-- P835's poison-pill quarantine logic counted escalation failures in an in-memory
-- Map<string, number> in timeout-cron.ts. The counter reset on every process restart,
-- so a row that failed escalation 2x on pod-A and 1x on pod-B (after a deploy)
-- was never marked POISON_PILL_DEAD_LETTER.
--
-- This column makes the counter durable. The timeout-cron no longer carries any
-- in-memory state for escalation failure tracking.

BEGIN;

ALTER TABLE roadmap.message_timeout_tracking
    ADD COLUMN IF NOT EXISTS escalation_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN roadmap.message_timeout_tracking.escalation_failure_count IS
    'P900: Durable escalation failure counter. Replaces the in-memory Map in timeout-cron.ts. '
    'Incremented atomically on each failed escalation notice delivery; reset to 0 on success. '
    'When it reaches ESCALATION_RETRY_LIMIT (3) the row is quarantined as POISON_PILL_DEAD_LETTER.';

COMMIT;
