-- P765 C5: offline episode tracking columns on provider_registry
-- offline_since_at: when the agency first went offline (this episode)
-- offline_alerted_at: when a Discord alert was sent (NULL = no alert yet this episode)
-- Both are cleared when the agency recovers via recordCheckIn (offline→dormant)
-- or agencyResume (operator force-resume).

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS offline_since_at   TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS offline_alerted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_registry_offline_alert
  ON roadmap_workforce.provider_registry (status, offline_alerted_at)
  WHERE status = 'offline';
