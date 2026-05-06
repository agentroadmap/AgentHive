-- P833: A2A Unified Message Envelope — trust-aware message contracts and timeouts
-- Phase 1: Extend message_ledger with correlation, expiry, signature, and trust fields
-- Phase 2: New tables for message contracts, registry, and timeout tracking
-- Phase 3: Seed message_type_contract catalog for dispatch gating

-- ============================================================
-- Phase 1: ALTER message_ledger
-- ============================================================

ALTER TABLE roadmap.message_ledger
ADD COLUMN IF NOT EXISTS correlation_id uuid,
ADD COLUMN IF NOT EXISTS expires_at timestamptz,
ADD COLUMN IF NOT EXISTS provider_sig text,
ADD COLUMN IF NOT EXISTS sig_verified text CHECK (sig_verified IN ('pending','verified','failed')) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS acked_at timestamptz,
ADD COLUMN IF NOT EXISTS ack_outcome text CHECK (ack_outcome IN ('ok','reject','noop')),
ADD COLUMN IF NOT EXISTS trust_tier text CHECK (trust_tier IN ('authority','known','restricted','blocked'));

-- ack_consistency CHECK: PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so guard via DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'roadmap'
      AND t.relname = 'message_ledger'
      AND c.conname = 'ack_consistency'
  ) THEN
    ALTER TABLE roadmap.message_ledger
      ADD CONSTRAINT ack_consistency CHECK ((acked_at IS NULL) = (ack_outcome IS NULL));
  END IF;
END $$;

-- Phase 1b: Indexes on message_ledger
CREATE INDEX IF NOT EXISTS msg_ledger_correlation_idx ON roadmap.message_ledger (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS msg_ledger_expires_idx ON roadmap.message_ledger (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS msg_ledger_unacked_idx ON roadmap.message_ledger (from_agent, created_at) WHERE acked_at IS NULL;

-- ============================================================
-- Phase 2: New Tables for A2A Message Envelope
-- ============================================================

-- agent_registry: Directory of agents with trust tiers and capabilities
CREATE TABLE IF NOT EXISTS roadmap.agent_registry (
  identity text PRIMARY KEY,
  provider text,                           -- 'orchestrator', 'liaison', 'spawn', etc.
  host_id text,                            -- Physical host identifier
  callback_url text,                       -- Webhook URL for async responses
  trust_tier text DEFAULT 'known' CHECK (trust_tier IN ('authority','known','restricted','blocked')),
  allowed_scopes text[] DEFAULT ARRAY[]::text[],  -- Scopes this agent can request
  denied_scopes text[] DEFAULT ARRAY[]::text[],   -- Scopes explicitly denied
  max_spawn_depth int DEFAULT 3,           -- Max nesting depth for spawn operations
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_registry_trust_idx ON roadmap.agent_registry (trust_tier);
CREATE INDEX IF NOT EXISTS agent_registry_provider_idx ON roadmap.agent_registry (provider);

COMMENT ON TABLE roadmap.agent_registry IS
'Agent directory with trust tiers and scope permissions. Trust tier determines message receipt,
DM initiation, and spawn depth limits. Updated on every agent heartbeat.';

-- message_type_contract: Catalog of allowed message types with ACK/timeout requirements
CREATE TABLE IF NOT EXISTS roadmap.message_type_contract (
  message_type text PRIMARY KEY,
  sender_roles text[] DEFAULT ARRAY[]::text[],        -- Allowed sender roles (empty = any)
  recipient_roles text[] DEFAULT ARRAY[]::text[],     -- Allowed recipient roles (empty = any)
  ack_required boolean DEFAULT false,                  -- Must recipient ACK this type?
  timeout_seconds int,                                -- Seconds before escalation (null = no timeout)
  escalation_recipient text,                          -- Who gets escalated (e.g., 'liaison_hub')
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE roadmap.message_type_contract IS
'Message type contracts define ACK requirements, timeout rules, and escalation paths.
Used by msg_send dispatch gate and msg_timeout_tracking.';

-- message_initiation_rule: Control which agent pairs can send which message types
CREATE TABLE IF NOT EXISTS roadmap.message_initiation_rule (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  from_role text NOT NULL,                            -- Sender role (e.g., 'liaison', 'spawn')
  to_role text NOT NULL,                              -- Recipient role
  allowed_types text[] NOT NULL DEFAULT ARRAY[]::text[],  -- Allowed message_types for this pair
  requires_same_agency boolean DEFAULT false,         -- Must sender and recipient be in same agency?
  requires_scope text,                                -- Sender must have this scope
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msg_init_rule_from_to_idx ON roadmap.message_initiation_rule (from_role, to_role);

COMMENT ON TABLE roadmap.message_initiation_rule IS
'Defines which message types can flow between role pairs. Enforced during msg_send dispatch gate.
Prevents unauthorized inter-agent communication.';

-- message_timeout_tracking: Per-message timeout/escalation state
CREATE TABLE IF NOT EXISTS roadmap.message_timeout_tracking (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id bigint NOT NULL UNIQUE,
  timeout_at timestamptz NOT NULL,
  reminder_sent_at timestamptz,
  escalated_at timestamptz,
  escalation_recipient text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_timeout_message_fk FOREIGN KEY (message_id) REFERENCES roadmap.message_ledger(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS msg_timeout_unescalated_idx ON roadmap.message_timeout_tracking (timeout_at) WHERE escalated_at IS NULL;
CREATE INDEX IF NOT EXISTS msg_timeout_message_idx ON roadmap.message_timeout_tracking (message_id);

COMMENT ON TABLE roadmap.message_timeout_tracking IS
'Tracks pending ACKs with timeout/escalation. When acked_at is set on the ledger,
the corresponding timeout entry is marked escalated_at = now() to cancel the timeout.';

-- message_validity_log: Audit trail for signature/permission/trust validation
CREATE TABLE IF NOT EXISTS roadmap.message_validity_log (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id bigint REFERENCES roadmap.message_ledger(id) ON DELETE CASCADE,
  signature_valid boolean,
  permission_valid boolean,
  trust_check_passed boolean,
  denial_reason text,
  checked_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msg_validity_message_idx ON roadmap.message_validity_log (message_id);
CREATE INDEX IF NOT EXISTS msg_validity_checked_idx ON roadmap.message_validity_log (checked_at DESC);

COMMENT ON TABLE roadmap.message_validity_log IS
'Audit trail for message validation failures. Tracks signature/permission/trust rejections
for debugging and compliance. Cleaned up after 30 days.';

-- ============================================================
-- Phase 3: Seed message_type_contract
-- ============================================================

INSERT INTO roadmap.message_type_contract (message_type, ack_required, timeout_seconds, escalation_recipient) VALUES
  ('task',               true,  300, 'liaison_hub'),
  ('directive',          true,   60, 'liaison_hub'),
  ('query',              false, null, null),
  ('progress_note',      false, null, null),
  ('request_assistance', true,  120, 'liaison_hub'),
  ('ack',                false, null, null),
  ('error',              false, null, null),
  ('event',              false, null, null),
  ('escalation_notice',  false, null, null),
  ('nack',               false, null, null),
  ('reminder',           false, null, null)
ON CONFLICT (message_type) DO NOTHING;

COMMENT ON COLUMN roadmap.message_type_contract.message_type IS
'Allowed message types: task (work offer), directive (instruction), query (read-only question),
progress_note (telemetry), request_assistance (help needed), and control types (ack, error, event, nack, reminder).';
