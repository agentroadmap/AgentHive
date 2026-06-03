-- P304: dead-letter queue for notifications that exhausted all delivery retries
CREATE TABLE IF NOT EXISTS roadmap.notification_dlq (
  id                BIGSERIAL PRIMARY KEY,
  -- FK to notification_queue (the delivery queue), NOT to notification (event log)
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
