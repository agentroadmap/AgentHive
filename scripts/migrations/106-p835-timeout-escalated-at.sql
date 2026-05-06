-- Migration 106: P835 — Add escalated_at to message_timeout_tracking
--
-- The timeout-cron escalation pass (timeout-cron.ts) uses escalated_at to
-- track which messages have already been escalated. Migration 100 (P833)
-- created message_timeout_tracking without this column.

BEGIN;

ALTER TABLE roadmap.message_timeout_tracking
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mtt_unescalated
  ON roadmap.message_timeout_tracking (timeout_at)
  WHERE escalated_at IS NULL AND resolved_at IS NULL;

COMMENT ON COLUMN roadmap.message_timeout_tracking.escalated_at IS
  'P835: Timestamp when this message was escalated. NULL = not yet escalated.';

COMMIT;
