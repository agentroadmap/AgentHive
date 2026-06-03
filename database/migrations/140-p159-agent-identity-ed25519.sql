-- P159: Wire Ed25519/HMAC identity verification into agent_registry
-- Adds public_key (Ed25519 SPKI-encoded hex) and key_rotated_at columns
-- to enable signature verification on agent-originated requests (soft-fail by default).

ALTER TABLE roadmap_workforce.agent_registry
ADD COLUMN IF NOT EXISTS public_key text,
ADD COLUMN IF NOT EXISTS key_rotated_at timestamp with time zone;

COMMENT ON COLUMN roadmap_workforce.agent_registry.public_key IS 'P159: Optional Ed25519 public key (SPKI-encoded, hex-string) for verifying agent-originated signatures';

COMMENT ON COLUMN roadmap_workforce.agent_registry.key_rotated_at IS 'P159: Timestamp of most recent key rotation; null if key never set';

-- Index for fast lookup by agent_identity (common operation in verifyAgentIdentity)
CREATE INDEX IF NOT EXISTS idx_agent_registry_identity_for_key_lookup
ON roadmap_workforce.agent_registry(agent_identity)
WHERE public_key IS NOT NULL;
