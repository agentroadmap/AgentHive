-- P1017 AC-22: Idempotent acknowledgment contract via dedicated message_ack table.
-- Nonce unique index enforces exactly-once ack delivery at the DB boundary.
-- Verification: INSERT same (nonce, message_id) twice → error 23505 on second attempt.

CREATE TABLE IF NOT EXISTS roadmap.message_ack (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id bigint        NOT NULL REFERENCES roadmap.message_ledger(id) ON DELETE CASCADE,
  nonce      uuid          NOT NULL,
  ack_by     text,
  acked_at   timestamptz   NOT NULL DEFAULT now(),
  outcome    text          NOT NULL DEFAULT 'ok'
    CHECK (outcome IN ('ok', 'reject', 'noop')),
  CONSTRAINT message_ack_nonce_unique UNIQUE (nonce)
);

CREATE INDEX IF NOT EXISTS message_ack_message_id_idx ON roadmap.message_ack (message_id);

COMMENT ON TABLE roadmap.message_ack IS
  'P1017 AC-22: One row per acknowledged message. Nonce enforces idempotent delivery — '
  'retrying with same nonce is safe and returns 23505 on duplicate.';
