-- P1106: Dead Letter Queue (DLQ) for message delivery failures
-- Captures messages that fail all retries or violate critical constraints.
-- AC: DLQ schema exists.

CREATE TABLE IF NOT EXISTS roadmap.dead_letter_queue (
  id                  BIGSERIAL PRIMARY KEY,
  original_message_id BIGINT REFERENCES roadmap.message_ledger(id) ON DELETE SET NULL,
  from_agent          TEXT NOT NULL,
  to_agent            TEXT,
  channel             TEXT,
  payload             TEXT,
  failure_reason      TEXT NOT NULL,
  retry_budget_used   INT NOT NULL DEFAULT 0,
  dead_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at         TIMESTAMPTZ,
  replay_succeeded    BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_dlq_unreplayed
  ON roadmap.dead_letter_queue(dead_at)
  WHERE replayed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dlq_from_agent
  ON roadmap.dead_letter_queue(from_agent);
