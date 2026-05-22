-- P765 C5: Add offline alert tracking columns to provider_registry
BEGIN;

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS offline_since_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offline_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN roadmap_workforce.provider_registry.offline_since_at IS
  'Set when status transitions to offline. Used to calculate 10-minute alert threshold. Cleared on recovery.';

COMMENT ON COLUMN roadmap_workforce.provider_registry.offline_alerted_at IS
  'Set when offline alert is emitted. NULL = no alert sent for current offline episode. Cleared on recovery.';

CREATE INDEX IF NOT EXISTS idx_provider_registry_offline_alert
  ON roadmap_workforce.provider_registry (offline_since_at)
  WHERE status = 'offline' AND offline_alerted_at IS NULL;

COMMIT;
