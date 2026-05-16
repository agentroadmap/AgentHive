/*
 * P1017 Phase A: Remove heartbeat noise from message_ledger
 *
 * Background:
 *   - 22,877 / 22,899 (99.9%) of 24h message_ledger volume is heartbeat events
 *   - Heartbeats are pure noise; authoritative presence is via roadmap.agency.last_heartbeat_at
 *   - Code path: liaison-boot → liaisonHeartbeat → propagateHeartbeat → INSERT (now removed)
 *
 * Strategy: DELETE (not INSERT...archive)
 *   - Heartbeat rows are telemetry-only artifacts with no business value or retention requirement
 *   - No other tables have foreign keys to these rows
 *   - Clearing the ledger surface reveals actual message traffic (~22 rows/day)
 *
 * Safety:
 *   - This runs AFTER the code change (liaison-hub.ts:propagateHeartbeat is now a no-op)
 *   - Running the migration on a live system with active agencies is safe:
 *     • New heartbeats will no longer insert (code change already live)
 *     • Historical deletions are asynchronous and non-blocking
 *     • No triggers or constraints depend on these rows
 */

DELETE FROM roadmap.message_ledger
 WHERE message_type = 'event'
   AND message_content = 'heartbeat';

-- Verification (run separately to confirm post-migration state):
-- SELECT COUNT(*) FROM roadmap.message_ledger
--  WHERE message_type = 'event' AND message_content = 'heartbeat';
-- Expected: 0
