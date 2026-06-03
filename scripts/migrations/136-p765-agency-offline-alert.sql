-- P765 C5: Auto-recovery and scope-aware alerting from liaison/scanner liveness
--
-- Adds offline_alert_sent_at to roadmap.agency so the scanner can debounce
-- offline alerts to a single emission per offline episode (AC-4).
--
-- Lifecycle of offline_alert_sent_at:
--   NULL     → no alert sent yet for current episode (or agency is not offline)
--   non-NULL → alert was sent; do NOT re-alert until the agency recovers
--   reset    → set back to NULL when agency transitions out of 'offline'
--              (recovery clears it so the next offline episode gets a fresh alert)

BEGIN;

ALTER TABLE roadmap.agency
  ADD COLUMN IF NOT EXISTS offline_alert_sent_at timestamptz;

COMMENT ON COLUMN roadmap.agency.offline_alert_sent_at IS
  'Timestamp of the last offline alert emitted for this agency. '
  'NULL when no alert is pending. Reset to NULL on recovery so each '
  'offline episode emits exactly one alert (P765 AC-4).';

COMMIT;
