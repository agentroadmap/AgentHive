-- P765 C5: Add alert deduplication column to provider_registry.
-- alert_sent_at is set when an offline-alert is dispatched and cleared on recovery,
-- ensuring a single Discord notification per offline episode (AC-4).

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS alert_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN roadmap_workforce.provider_registry.alert_sent_at
  IS 'Timestamp the offline alert was sent for the current episode; NULL until first alert, cleared on recovery.';
