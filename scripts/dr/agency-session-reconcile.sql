-- ============================================================
-- P594 — DR companion: agency session reconciliation
-- ============================================================
-- Usage:
--   psql hiveCentral \
--     -v failover_time="'2026-04-26 21:00:00+00'" \
--     -f scripts/dr/agency-session-reconcile.sql
--
-- Cutoff logic: failover_time - 60s (matches lease-reconcile.sql arithmetic).
-- Implementation: direct UPDATE on agency.agency_session.
-- This script does NOT use queue-fanout (that is lease-reconcile.sql's approach
-- for roadmap proposal leases). These are separate scripts targeting different
-- tables; they must not be conflated (AC-6).
--
-- Sessions last seen BEFORE the cutoff (stale before failover) → dormant.
-- Sessions last seen AT or AFTER the cutoff (alive at failover) → reconnecting,
-- with a 60-second grace window to reconnect.
-- ============================================================

DO $$
DECLARE
  v_failover_time   TIMESTAMPTZ := :'failover_time'::TIMESTAMPTZ;
  v_cutoff          TIMESTAMPTZ := v_failover_time - interval '60 seconds';
  v_grace_until     TIMESTAMPTZ := v_failover_time + interval '60 seconds';
  v_dormant_count   INT;
  v_reconnect_count INT;
BEGIN
  -- Sessions stale before failover: close them as dormant
  UPDATE agency.agency_session
  SET dormancy_state = 'dormant',
      ended_at       = v_failover_time,
      end_reason     = 'dr_failover_stale'
  WHERE dormancy_state = 'active'
    AND ended_at IS NULL
    AND last_heartbeat_at < v_cutoff;
  GET DIAGNOSTICS v_dormant_count = ROW_COUNT;

  -- Sessions alive at failover: give them a reconnect grace window
  UPDATE agency.agency_session
  SET dormancy_state        = 'reconnecting',
      reconnect_grace_until = v_grace_until
  WHERE dormancy_state = 'active'
    AND ended_at IS NULL
    AND last_heartbeat_at >= v_cutoff;
  GET DIAGNOSTICS v_reconnect_count = ROW_COUNT;

  RAISE NOTICE 'DR agency reconcile: dormant=%, reconnecting=%, cutoff=%, grace_until=%',
    v_dormant_count, v_reconnect_count, v_cutoff, v_grace_until;
END $$;
