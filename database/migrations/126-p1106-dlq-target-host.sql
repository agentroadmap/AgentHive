-- P1106-E: dead_letter_queue for A2A dispatcher + target_host_id in message_ledger
-- F1: target_host_id in HMAC signing scope
-- F4: canonical DLQ table for dispatcher failure persistence

-- ============================================================
-- F1: Add target_host_id to message_ledger for HMAC replay prevention
-- ============================================================
ALTER TABLE roadmap.message_ledger
  ADD COLUMN IF NOT EXISTS target_host_id text;

CREATE INDEX IF NOT EXISTS msg_ledger_target_host_idx
  ON roadmap.message_ledger (target_host_id) WHERE target_host_id IS NOT NULL;

COMMENT ON COLUMN roadmap.message_ledger.target_host_id IS
'Target host identifier included in HMAC signing scope to prevent cross-host replay attacks.
Set on outbound cross-host messages; verified by the receiving host.';

-- ============================================================
-- F4: roadmap.dead_letter_queue — canonical DLQ for dispatcher failures
-- ============================================================
CREATE TABLE IF NOT EXISTS roadmap.dead_letter_queue (
  id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id     bigint REFERENCES roadmap.message_ledger(id) ON DELETE SET NULL,
  from_agent     text    NOT NULL,
  to_agent       text,
  message_type   text,
  message_content text   NOT NULL,
  error_detail   text    NOT NULL,
  retry_count    int     NOT NULL DEFAULT 0,
  sig_verified   text    CHECK (sig_verified IN ('pending', 'verified', 'failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_retry_at  timestamptz,
  replayed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS dlq_created_idx
  ON roadmap.dead_letter_queue (created_at DESC);

CREATE INDEX IF NOT EXISTS dlq_message_id_idx
  ON roadmap.dead_letter_queue (message_id);

CREATE INDEX IF NOT EXISTS dlq_pending_replay_idx
  ON roadmap.dead_letter_queue (created_at)
  WHERE replayed_at IS NULL;

COMMENT ON TABLE roadmap.dead_letter_queue IS
'Failed A2A messages that could not be dispatched. Persisted for audit and replay.
sig_verified must be "verified" before replay. replayed_at is set on successful replay.
F5: dlqReplay() refuses to replay rows where sig_verified != "verified".';

-- sig_verified index for pending-reconciler efficiency
CREATE INDEX IF NOT EXISTS msg_ledger_sig_pending_idx
  ON roadmap.message_ledger (created_at)
  WHERE sig_verified = 'pending';
