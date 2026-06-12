-- P1859: Add credential_key and stale_flag to agent_usage_snapshot
--
-- credential_key: Unique identifier for (OS-user, provider) credential pair
-- Allows multiple agencies sharing same credential to read single snapshot row
--
-- stale_flag: Boolean indicating if the measurement is stale or failed
-- When probe fails (404, 429, expired token), row is written with stale_flag=true
-- Consumers fail open on stale data rather than crashing

ALTER TABLE roadmap_workforce.agent_usage_snapshot
  ADD COLUMN IF NOT EXISTS credential_key TEXT,
  ADD COLUMN IF NOT EXISTS stale_flag BOOLEAN NOT NULL DEFAULT false;

-- Create unique index on credential_key (allows per-provider credentials to coexist)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_usage_snapshot_credential_key
  ON roadmap_workforce.agent_usage_snapshot(credential_key)
  WHERE credential_key IS NOT NULL;

-- Add comment for credential_key
COMMENT ON COLUMN roadmap_workforce.agent_usage_snapshot.credential_key IS
  'P1859: Unique identifier for (OS-user, provider) credential pair. Multiple agencies sharing the same credential read from the same snapshot row.';

COMMENT ON COLUMN roadmap_workforce.agent_usage_snapshot.stale_flag IS
  'P1859: Boolean flag indicating measurement is stale or from a failed probe. true when probe fails (404/429/expired token/format change). Consumers fail open on stale data.';
