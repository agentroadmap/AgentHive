-- P900: Persist escalation_failure_count so poison-pill survives timeout-cron restart
-- Adds a durable counter column to message_timeout_tracking.
-- Existing rows default to 0 (worst case: one extra retry after deploy, which is acceptable).

ALTER TABLE roadmap.message_timeout_tracking
    ADD COLUMN IF NOT EXISTS escalation_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN roadmap.message_timeout_tracking.escalation_failure_count IS
'Cumulative escalation send failures for this message. Incremented atomically on each failure.
When it reaches ESCALATION_RETRY_LIMIT (3), escalation_recipient is flipped to POISON_PILL_DEAD_LETTER.
Survives cron host restarts because it lives in the DB, not in-process memory.';
