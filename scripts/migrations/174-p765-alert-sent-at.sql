-- P765 C5: Auto-recovery and scope-aware alerting
-- Add alert_sent_at to provider_registry for single-shot offline alert deduplication (AC-4).

BEGIN;

ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS alert_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN roadmap_workforce.provider_registry.alert_sent_at
  IS 'Timestamp when offline Discord alert was sent; NULL = not yet alerted. Reset on recovery.';

COMMIT;
