-- P761 C1: Agency liveness state machine
-- Widen provider_registry to support 5-state status machine

BEGIN;

-- Step 1: Add status column (default 'active' for existing rows)
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Step 2: Add constraint
ALTER TABLE roadmap_workforce.provider_registry
  DROP CONSTRAINT IF EXISTS provider_registry_status_check;
ALTER TABLE roadmap_workforce.provider_registry
  ADD CONSTRAINT provider_registry_status_check
    CHECK (status IN ('active','throttled','dormant','offline','retired'));

-- Step 3: Add liveness columns
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS throttle_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_reason  TEXT;

-- Step 4: Index for resolver performance
CREATE INDEX IF NOT EXISTS idx_provider_registry_status
  ON roadmap_workforce.provider_registry (status);

-- Step 5: Set initial last_seen_at = registered_at for existing rows
UPDATE roadmap_workforce.provider_registry
  SET last_seen_at = registered_at
  WHERE last_seen_at IS NULL;

GRANT SELECT, UPDATE ON roadmap_workforce.provider_registry TO agent_read;
GRANT SELECT, INSERT, UPDATE ON roadmap_workforce.provider_registry TO agent_write;

COMMIT;
