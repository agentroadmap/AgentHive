-- P836: A2A Cross-Host Delivery — HTTP callback relay with SSRF prevention and HMAC auth
-- Phase 1: Extend agent_registry for callback delivery configuration
-- Phase 2: Extend message_validity_log for delivery tracking
-- Phase 3: Create delivery dedup table (multi-replica safe)

-- ============================================================
-- Phase 1: Extend agent_registry for callback delivery
-- ============================================================

ALTER TABLE roadmap.agent_registry
  ADD COLUMN IF NOT EXISTS callback_url text,
  ADD COLUMN IF NOT EXISTS callback_url_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS callback_url_validated_ip text,
  ADD COLUMN IF NOT EXISTS delivery_signing_key text;

COMMENT ON COLUMN roadmap.agent_registry.callback_url IS
'HTTPS endpoint for async callback delivery of messages. Must pass SSRF validation before use.
If null, delivery is synchronous via message_ledger only.';

COMMENT ON COLUMN roadmap.agent_registry.callback_url_verified_at IS
'Timestamp of last successful SSRF validation of callback_url. Re-validated before each delivery
for DNS rebinding protection.';

COMMENT ON COLUMN roadmap.agent_registry.callback_url_validated_ip IS
'IP address resolved during last SSRF validation. Stored for audit trail and debugging.';

COMMENT ON COLUMN roadmap.agent_registry.delivery_signing_key IS
'Per-agent HMAC signing secret for callback delivery (optional, encrypted in transit).
If null, falls back to DELIVERY_SIGNING_SECRET env var. Stored as hex-encoded 32-byte secret.';

-- ============================================================
-- Phase 2: Extend message_validity_log for delivery tracking
-- ============================================================

ALTER TABLE roadmap.message_validity_log
  ADD COLUMN IF NOT EXISTS delivery_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_status text CHECK (delivery_status IN ('pending','success','4xx','5xx','blocked')),
  ADD COLUMN IF NOT EXISTS delivery_response_code int;

COMMENT ON COLUMN roadmap.message_validity_log.delivery_attempted_at IS
'Timestamp of last delivery attempt to callback_url (if applicable).';

COMMENT ON COLUMN roadmap.message_validity_log.delivery_status IS
'Status of callback delivery: pending (not yet attempted), success (2xx), 4xx (client error),
5xx (server error), blocked (SSRF validation failed).';

COMMENT ON COLUMN roadmap.message_validity_log.delivery_response_code IS
'HTTP response code from last delivery attempt (if applicable).';

-- ============================================================
-- Phase 3: Delivery dedup table (multi-replica safe)
-- ============================================================

CREATE TABLE IF NOT EXISTS roadmap.delivery_id_log (
  delivery_id uuid PRIMARY KEY,
  received_at timestamptz DEFAULT now()
);

COMMENT ON TABLE roadmap.delivery_id_log IS
'Log of seen delivery IDs to prevent replay attacks in cross-host message delivery.
Each delivery POST includes X-AgentHive-Delivery-Id (UUID), checked against this table.
Entries older than 10 minutes are cleaned periodically.';

CREATE INDEX IF NOT EXISTS delivery_id_log_received_at_idx
  ON roadmap.delivery_id_log (received_at);

-- ============================================================
-- Phase 4: Indexes for delivery workflow
-- ============================================================

CREATE INDEX IF NOT EXISTS agent_registry_callback_url_idx
  ON roadmap.agent_registry (identity) WHERE callback_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS msg_validity_delivery_status_idx
  ON roadmap.message_validity_log (delivery_status) WHERE delivery_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS msg_validity_delivery_attempted_idx
  ON roadmap.message_validity_log (delivery_attempted_at DESC) WHERE delivery_attempted_at IS NOT NULL;
