-- Migration 149: P304 — notification_dlq table
--
-- Summary:
--   Dead-letter queue for notification_queue rows that have exhausted all
--   send retries (attempt_count >= 4). moveToDlq() in the gateway sets
--   notification_queue.status='failed' and inserts here atomically (AC#8).
--   DLQ depth alerting fires when unresolved rows exceed 10 (AC#11).
--
-- Note: FK references roadmap.notification_queue(id), the delivery queue,
--   NOT roadmap.notification (the event log).

CREATE TABLE IF NOT EXISTS roadmap.notification_dlq (
  id                BIGSERIAL PRIMARY KEY,
  notification_id   BIGINT NOT NULL REFERENCES roadmap.notification_queue(id),
  channel           TEXT   NOT NULL,
  last_error        TEXT,
  attempt_count     SMALLINT NOT NULL DEFAULT 0,
  first_failed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  UNIQUE (notification_id)
);

CREATE INDEX IF NOT EXISTS notification_dlq_unresolved_idx
  ON roadmap.notification_dlq (first_failed_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE roadmap.notification_dlq IS
'Dead-letter queue for notification_queue rows that exhausted retries (P304).
Rows are created by moveToDlq() when attempt_count >= 4.
resolved_at is set by operator or automated retry (pg_cron after 24h).
DLQ depth alert fires via checkDlqDepthAndAlert() when unresolved > 10.';
