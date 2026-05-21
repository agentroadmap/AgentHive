-- 176-fix-agency-status-allow-offline.sql
--
-- The chk_agency_status check constraint allowed:
--   {unknown, active, throttled, paused, dormant, retired}
-- But src/infra/agency/liaison-service.ts:304 and the liveness alerting code
-- (src/infra/agency/liveness-alerting.ts:46) write status='offline' as a
-- distinct lifecycle state (between dormant and retired). The mismatch caused
-- 'Liveness alert tick failed: new row for relation "agency" violates check
-- constraint "chk_agency_status"' on every 60s liveness tick.
--
-- Replace the constraint to add 'offline' to the allowed set. The pre-existing
-- 'NOT VALID' attribute is preserved so we don't re-scan the table.

ALTER TABLE roadmap.agency DROP CONSTRAINT IF EXISTS chk_agency_status;
ALTER TABLE roadmap.agency
  ADD CONSTRAINT chk_agency_status
  CHECK (status = ANY (ARRAY[
    'unknown'::text,
    'active'::text,
    'throttled'::text,
    'paused'::text,
    'dormant'::text,
    'offline'::text,
    'retired'::text
  ])) NOT VALID;
