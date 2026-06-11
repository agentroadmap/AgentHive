-- P2404 Liveness Poke Verification Script
--
-- AC-2 (regression guard): Verify that a timed-out poke NEWER than the heartbeat
--   still shows 'stale-unresponsive', ensuring Part A doesn't blanket-suppress
--   the real stale signal.
--
-- AC-3 (live verification): Verify that a fresh heartbeat OVERRIDES an older
--   timed-out poke, showing 'live-*' instead of 'stale-unresponsive'.
--
-- This script is hermetic: it uses BEGIN/ROLLBACK to leave no trace in the DB.
-- Run with: psql -d agenthive -f tests/infra/agency/p2404-liveness-poke-verification.sql

BEGIN;

SET search_path = roadmap, roadmap_workforce, public;

-- ============================================================================
-- Test Data Setup
-- ============================================================================

-- Insert test agency
INSERT INTO roadmap.agency
 (agency_id, display_name, provider, host_id, status, presence_state, last_heartbeat_at)
VALUES
  ('test/p2404-ac2-guard', 'P2404 AC-2 Regression Guard Test', 'test', 'iMac', 'active', 'online', now() - interval '60 seconds'),
  ('test/p2404-ac3-fresh', 'P2404 AC-3 Fresh Heartbeat Test', 'test', 'iMac', 'active', 'online', now() - interval '10 seconds');

-- AC-2 Test: timed_out poke NEWER than heartbeat should still show 'stale-unresponsive'
-- Heartbeat is 60s old, poke is 10s old (NEWER than heartbeat)
INSERT INTO roadmap.liaison_poke_attempt
 (agency_id, poke_message_id, outcome, poked_at, timeout_at, resolved_at)
VALUES
  ('test/p2404-ac2-guard', gen_random_uuid(), 'timed_out', now() - interval '10 seconds', now() - interval '9 seconds', now() - interval '9 seconds');

-- AC-3 Test: timed_out poke OLDER than heartbeat should show 'live-but-idle'
-- Heartbeat is 10s old, poke is 40 hours old (OLDER than heartbeat)
INSERT INTO roadmap.liaison_poke_attempt
 (agency_id, poke_message_id, outcome, poked_at, timeout_at, resolved_at)
VALUES
  ('test/p2404-ac3-fresh', gen_random_uuid(), 'timed_out', now() - interval '40 hours', now() - interval '39 hours 59 minutes', now() - interval '39 hours 59 minutes');

-- ============================================================================
-- AC-2 Verification: Regression Guard
-- ============================================================================

\echo ''
\echo '========== AC-2: REGRESSION GUARD =========='
\echo 'Test: timed_out poke NEWER than heartbeat still shows stale-unresponsive'
\echo ''

SELECT
  'test/p2404-ac2-guard'::text AS agency_id,
  v.liveness_state,
  v.dispatchable,
  a.last_heartbeat_at,
  lp.outcome,
  lp.poked_at,
  (lp.poked_at > a.last_heartbeat_at) AS poke_is_newer,
  CASE
    WHEN v.liveness_state = 'stale-unresponsive' THEN 'PASS: Fresh poke (newer than heartbeat) correctly shows stale-unresponsive'
    ELSE 'FAIL: Expected stale-unresponsive, got ' || v.liveness_state
  END AS ac2_result
FROM roadmap.v_agency_status v
JOIN roadmap.agency a ON v.agency_id = a.agency_id
LEFT JOIN LATERAL (
  SELECT outcome, poked_at FROM roadmap.liaison_poke_attempt
  WHERE agency_id = a.agency_id AND outcome IS NOT NULL
  ORDER BY poked_at DESC LIMIT 1
) lp ON true
WHERE a.agency_id = 'test/p2404-ac2-guard';

-- ============================================================================
-- AC-3 Verification: Fresh Heartbeat Overrides Stale Poke
-- ============================================================================

\echo ''
\echo '========== AC-3: FRESH HEARTBEAT OVERRIDES =========='
\echo 'Test: heartbeat NEWER than timed_out poke shows live-but-idle (not stale)'
\echo ''

SELECT
  'test/p2404-ac3-fresh'::text AS agency_id,
  v.liveness_state,
  v.dispatchable,
  a.last_heartbeat_at,
  lp.outcome,
  lp.poked_at,
  (a.last_heartbeat_at > lp.poked_at) AS heartbeat_is_fresher,
  CASE
    WHEN v.liveness_state LIKE 'live-%' THEN 'PASS: Fresh heartbeat (newer than poke) correctly shows live-* state'
    WHEN v.liveness_state = 'stale-unresponsive' THEN 'FAIL: Got stale-unresponsive (Part A fix not working)'
    ELSE 'FAIL: Unexpected state: ' || v.liveness_state
  END AS ac3_result
FROM roadmap.v_agency_status v
JOIN roadmap.agency a ON v.agency_id = a.agency_id
LEFT JOIN LATERAL (
  SELECT outcome, poked_at FROM roadmap.liaison_poke_attempt
  WHERE agency_id = a.agency_id AND outcome IS NOT NULL
  ORDER BY poked_at DESC LIMIT 1
) lp ON true
WHERE a.agency_id = 'test/p2404-ac3-fresh';

-- ============================================================================
-- Verify Column Presence (Part A migration verification)
-- ============================================================================

\echo ''
\echo '========== MIGRATION 195 VERIFICATION =========='
\echo 'Checking v_agency_status view columns for Part A fix'
\echo ''

SELECT
  'liveness_state column'::text AS check_item,
  CASE
    WHEN count(*) > 0 THEN 'PASS: liveness_state column exists in v_agency_status'
    ELSE 'FAIL: liveness_state column missing'
  END AS result
FROM information_schema.columns
WHERE table_schema = 'roadmap' AND table_name = 'v_agency_status'
  AND column_name = 'liveness_state'

UNION ALL

SELECT
  'poked_at selection'::text,
  CASE
    WHEN pg_get_viewdef('roadmap.v_agency_status'::regclass)::text LIKE '%poked_at%'
    THEN 'PASS: poked_at is selected in last_poke lateral'
    ELSE 'FAIL: poked_at not in view definition'
  END
FROM (SELECT 1)

UNION ALL

SELECT
  'heartbeat comparison gate'::text,
  CASE
    WHEN pg_get_viewdef('roadmap.v_agency_status'::regclass)::text LIKE '%last_poke.poked_at > a.last_heartbeat_at%'
    THEN 'PASS: v_agency_status gates timed_out on poked_at > last_heartbeat_at'
    ELSE 'FAIL: Missing heartbeat comparison gate'
  END
FROM (SELECT 1);

-- ============================================================================
-- Cleanup (rollback will erase all changes)
-- ============================================================================

ROLLBACK;

\echo ''
\echo '========== TEST COMPLETE (ROLLED BACK) =========='
\echo 'All test data has been removed by ROLLBACK.'
\echo ''
