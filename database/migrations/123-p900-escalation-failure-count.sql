-- P900: Persist escalation_failure_count so poison-pill survives timeout-cron restart
--
-- P835's poison-pill logic used an in-memory Map<string, number> that reset on
-- every pod restart. A row that failed escalation 2x on pod-A and 1x on pod-B
-- was never quarantined. This migration adds a durable counter so the 3-strike
-- threshold is accumulated across restarts and hosts.

ALTER TABLE roadmap.message_timeout_tracking
  ADD COLUMN IF NOT EXISTS escalation_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN roadmap.message_timeout_tracking.escalation_failure_count IS
'Cumulative escalation delivery failures. When this reaches ESCALATION_RETRY_LIMIT (3),
the row is quarantined by setting escalation_recipient = POISON_PILL_DEAD_LETTER.
Durable across cron-host restarts and multi-pod deploys.';
