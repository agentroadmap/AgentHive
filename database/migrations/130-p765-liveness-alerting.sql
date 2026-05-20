-- P765: Liveness alerting — offline alert debounce column.
--
-- Adds offline_alert_sent_at to roadmap.agency so the alerting scanner
-- can emit single-shot Discord alerts without repeating every tick.
-- Cleared on recovery; set when first alert fires per offline-episode.

BEGIN;

ALTER TABLE roadmap.agency
  ADD COLUMN IF NOT EXISTS offline_alert_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN roadmap.agency.offline_alert_sent_at IS
  'Set when a Discord offline-alert fires for this agency. Cleared on recovery. Prevents repeated alerts per offline episode (AC-4).';

COMMIT;
