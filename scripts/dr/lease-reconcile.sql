-- ============================================================
-- P594 — DR companion: dispatch lease reconciliation
-- ============================================================
-- Usage:
--   psql hiveCentral \
--     -v failover_time="'2026-04-26 21:00:00+00'" \
--     -f scripts/dr/lease-reconcile.sql
--
-- Cutoff logic: failover_time - 60s (matches agency-session-reconcile.sql arithmetic).
-- Implementation: direct UPDATE on roadmap.proposal_lease.
-- This script targets dispatch leases (roadmap.proposal_lease), NOT
-- agency sessions (agency.agency_session). Those are separate scripts
-- targeting separate tables — they must not be conflated (AC-6).
--
-- Leases that expired before the failover cutoff → released (set ended_at).
-- In-flight leases alive at failover → left intact; the acquiring agent
-- will discover the reconnect window via agency_session.reconnect_grace_until
-- and resume or release voluntarily.
-- ============================================================

DO $$
DECLARE
  v_failover_time  TIMESTAMPTZ := :'failover_time'::TIMESTAMPTZ;
  v_cutoff         TIMESTAMPTZ := v_failover_time - interval '60 seconds';
  v_released_count INT;
BEGIN
  -- Release leases that were already stale before the failover cutoff
  UPDATE roadmap.proposal_lease
  SET    ended_at   = v_failover_time,
         end_reason = 'dr_failover'
  WHERE  ended_at   IS NULL
    AND  last_renewed_at < v_cutoff;

  GET DIAGNOSTICS v_released_count = ROW_COUNT;

  RAISE NOTICE 'lease-reconcile: released % stale leases (cutoff=%)', v_released_count, v_cutoff;
END $$;
