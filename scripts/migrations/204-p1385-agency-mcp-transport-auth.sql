-- P1385: MCP agency work transport — Add token_hash column for bearer auth
--
-- Adds token_hash TEXT column to roadmap_workforce.agent_registry to store
-- SHA-256 hash of bearer tokens used for agency_subscribe/agency_submit_result/
-- agency_heartbeat authentication when MCP_AGENCY_AUTH=on.
--
-- Token is issued once at registration (P1129 agency_register_full) and stored
-- as hash only (plaintext never persisted). Bearer header checked against token_hash.

BEGIN;

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS token_hash TEXT
  CONSTRAINT token_hash_unique UNIQUE;

-- Create index for bearer auth lookup performance
CREATE INDEX IF NOT EXISTS idx_agent_registry_token_hash
  ON roadmap_workforce.agent_registry(token_hash)
  WHERE token_hash IS NOT NULL;

COMMIT;
