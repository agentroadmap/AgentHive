-- P3782: Add category column to core.runtime_flag + backfill
--
-- Adds a closed-taxonomy category column so operators and the TUI can
-- group/filter flags by subsystem without parsing flag_name prefixes.
--
-- Taxonomy (CHECK constraint):
--   orchestration | a2a | agency | feature_flag | budget | billing
--   ui | security | model_routing | system | uncategorized
--
-- DEFAULT 'uncategorized' so existing rows survive the ALTER without
-- breaking anything; backfill below brings all known seeded flags to
-- their correct category in the same transaction.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + ON CONFLICT-safe updates.

BEGIN;

ALTER TABLE core.runtime_flag
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'uncategorized'
  CHECK (category IN (
    'orchestration','a2a','agency','feature_flag',
    'budget','billing','ui','security','model_routing',
    'system','uncategorized'
  ));

-- Backfill: orchestration (ORCHESTRATOR_* + PAUSE_* + USE_OFFER_DISPATCH)
UPDATE core.runtime_flag SET category = 'orchestration'
WHERE flag_name IN (
  'ORCHESTRATOR_SCAN_BATCH_LIMIT',
  'ORCHESTRATOR_STALL_THRESHOLD_HOURS',
  'ORCHESTRATOR_STALL_BATCH_LIMIT',
  'ORCHESTRATOR_OFFER_REAP_MS',
  'ORCHESTRATOR_POKE_IDLE_MIN',
  'ORCHESTRATOR_POKE_STORM_CAP',
  'ORCHESTRATOR_MAX_INFLIGHT_OFFERS',
  'ORCHESTRATOR_SHUTDOWN_DRAIN_MS',
  'ORCHESTRATOR_IMPLICIT_GATE_POLL_MS',
  'ORCHESTRATOR_ENHANCER_REVISE_MS',
  'ORCHESTRATOR_RECONCILER_MS',
  'ORCHESTRATOR_STALE_ROW_REAPER_MS',
  'ORCHESTRATOR_STUCK_WORKER_MS',
  'ORCHESTRATOR_HEARTBEAT_MS',
  'ORCHESTRATOR_OFFER_CLAIM_ENABLED',
  'PAUSE_FAILURE_THRESHOLD',
  'PAUSE_BASE_BACKOFF_MS',
  'PAUSE_BACKOFF_MULTIPLIER',
  'PAUSE_MAX_BACKOFF_MS',
  'USE_OFFER_DISPATCH'
) AND category = 'uncategorized';

-- Backfill: a2a (A2A_HOST_* + LIAISON_*)
UPDATE core.runtime_flag SET category = 'a2a'
WHERE flag_name IN (
  'A2A_HOST_LISTEN_REFRESH_MS',
  'A2A_HOST_PG_RECONNECT_MS',
  'A2A_HOST_SHUTDOWN_TIMEOUT_MS',
  'A2A_HOST_PRESENCE_REFRESH_MS',
  'LIAISON_CONTEXT_REFRESH_MS'
) AND category = 'uncategorized';

-- Backfill: agency (AGENCY_* + SPAWN_*)
UPDATE core.runtime_flag SET category = 'agency'
WHERE flag_name IN (
  'AGENCY_OFFER_CLAIM_ENABLED',
  'SPAWN_PROVIDER_MAX_ATTEMPTS'
) AND category = 'uncategorized';

-- Backfill: feature_flag (ENABLE_*)
UPDATE core.runtime_flag SET category = 'feature_flag'
WHERE flag_name IN (
  'ENABLE_MULTI_TENANT',
  'ENABLE_AUDIT_LOG'
) AND category = 'uncategorized';

-- Backfill: ui
UPDATE core.runtime_flag SET category = 'ui'
WHERE flag_name = 'AGENTHIVE_COCKPIT_LAYOUT'
  AND category = 'uncategorized';

COMMIT;
