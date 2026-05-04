-- P834: A2A Identity & Trust — agent_secret, HMAC dispatch gate, spawn grant verification
-- Phase 1: Envelope Encryption with External Master Key
-- Phase 2: Credential Delivery Layer (spawn_bucket in-memory)
-- Phase 3: Signature Derivation Layer (RFC 5869 HKDF)

-- ============================================================
-- Phase 1: agent_secret with Envelope Encryption
-- ============================================================

CREATE TABLE IF NOT EXISTS roadmap.agent_secret (
  agent_identity text PRIMARY KEY,
  secret_encrypted bytea NOT NULL,      -- AES-256-GCM ciphertext of 512-bit agent secret
  secret_nonce bytea NOT NULL,          -- 96-bit random nonce (unique per row/rotation)
  secret_tag bytea NOT NULL,            -- 128-bit GCM authentication tag (tamper detection)
  key_version int NOT NULL DEFAULT 1,   -- maps ciphertext to master key version that encrypted it
  created_at timestamptz DEFAULT now(),
  rotated_at timestamptz,               -- timestamp of last rotation
  rotation_due_at timestamptz DEFAULT now() + interval '90 days',
  CONSTRAINT agent_secret_key_version_check CHECK (key_version >= 1)
);

CREATE INDEX IF NOT EXISTS agent_secret_key_version_idx ON roadmap.agent_secret (key_version);
CREATE INDEX IF NOT EXISTS agent_secret_rotation_due_idx ON roadmap.agent_secret (rotation_due_at) WHERE rotated_at IS NULL;

COMMENT ON TABLE roadmap.agent_secret IS
'Cryptographic secrets for A2A message signing. Secrets are encrypted with AES-256-GCM using
external master key. Database stores only ciphertext, nonce, tag, key_version; master key
never persists to disk. Rotation every 90 days with overlap window.';

COMMENT ON COLUMN roadmap.agent_secret.secret_encrypted IS
'AES-256-GCM ciphertext of 512-bit agent_secret. AAD is agent_identity (prevents transplant attacks).';

COMMENT ON COLUMN roadmap.agent_secret.key_version IS
'Identifies which master key version encrypted this row. Enables key rotation with overlap window.';

-- ============================================================
-- Phase 2: Add provider_sig_salt to message_ledger (IMP-3A)
-- ============================================================

ALTER TABLE roadmap.message_ledger
  ADD COLUMN IF NOT EXISTS provider_sig_salt bytea;

COMMENT ON COLUMN roadmap.message_ledger.provider_sig_salt IS
'Random 32-byte salt used in RFC 5869 HKDF for this message signature. Stored alongside
provider_sig to achieve strict per-message key uniqueness. Read at verification time.';

-- ============================================================
-- Phase 3: Indexes for dispatch gate queries
-- ============================================================

CREATE INDEX IF NOT EXISTS msg_ledger_sig_verified_idx ON roadmap.message_ledger (sig_verified) WHERE sig_verified IN ('verified', 'failed');
CREATE INDEX IF NOT EXISTS msg_ledger_from_agent_sig_idx ON roadmap.message_ledger (from_agent, created_at DESC) WHERE sig_verified = 'verified';
