-- P1017 AC-22: Idempotent acknowledgment contract.
-- message_ack stores per-message acknowledgments with a nonce unique index
-- so re-sending the same ack (same nonce) produces error 23505, not a
-- duplicate row. Enables at-most-once delivery semantics.

CREATE TABLE IF NOT EXISTS roadmap.message_ack (
    id             bigserial PRIMARY KEY,
    message_id     bigint NOT NULL REFERENCES roadmap.message_ledger(id) ON DELETE CASCADE,
    nonce          text NOT NULL,
    acked_by       text NOT NULL,
    ack_outcome    text NOT NULL DEFAULT 'ack' CHECK (ack_outcome IN ('ack', 'nack', 'error')),
    ack_detail     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The nonce unique index is the at-most-once enforcement point (AC-22).
CREATE UNIQUE INDEX IF NOT EXISTS message_ack_nonce_uidx
    ON roadmap.message_ack (nonce);

-- Fast lookups per message.
CREATE INDEX IF NOT EXISTS message_ack_message_id_idx
    ON roadmap.message_ack (message_id);

COMMENT ON TABLE roadmap.message_ack IS
    'P1017 AC-22: per-message acks with nonce dedup. Nonce uniqueness enforces at-most-once delivery.';

-- Verify:
-- INSERT INTO roadmap.message_ack (message_id, nonce, acked_by) VALUES (1, 'test-nonce-1', 'system');
-- INSERT INTO roadmap.message_ack (message_id, nonce, acked_by) VALUES (1, 'test-nonce-1', 'system');
-- → ERROR 23505 unique_violation on second INSERT.
