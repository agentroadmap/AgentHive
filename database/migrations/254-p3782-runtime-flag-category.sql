-- P3782: Add category column to core.runtime_flag + backfill.
--
-- Adds a category TEXT NOT NULL DEFAULT 'uncategorized' column with a closed CHECK
-- constraint so each flag is slotted into one of the canonical taxonomy buckets.
-- A backfill UPDATE in the same transaction sets the correct category for every
-- seeded flag row (zero rows should remain 'uncategorized' after apply).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS means re-running is safe.
-- Trigger behaviour is unchanged.

BEGIN;

ALTER TABLE core.runtime_flag
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'uncategorized'
  CHECK (category IN (
    'orchestration', 'a2a', 'agency', 'feature_flag',
    'budget', 'billing', 'ui', 'security',
    'model_routing', 'system', 'uncategorized'
  ));

-- Backfill: set category for all known flag names.
-- Any row whose flag_name doesn't match the list stays 'uncategorized'.
UPDATE core.runtime_flag
SET category = CASE flag_name

  -- ── feature flags ─────────────────────────────────────────────────────────
  WHEN 'USE_OFFER_DISPATCH'             THEN 'feature_flag'
  WHEN 'ENABLE_MULTI_TENANT'            THEN 'feature_flag'
  WHEN 'ENABLE_AUDIT_LOG'               THEN 'feature_flag'

  -- ── A2A / liaison ─────────────────────────────────────────────────────────
  WHEN 'A2A_HOST_LISTEN_REFRESH_MS'     THEN 'a2a'
  WHEN 'A2A_HOST_PG_RECONNECT_MS'       THEN 'a2a'
  WHEN 'A2A_HOST_SHUTDOWN_TIMEOUT_MS'   THEN 'a2a'
  WHEN 'A2A_HOST_PRESENCE_REFRESH_MS'   THEN 'a2a'
  WHEN 'LIAISON_CONTEXT_REFRESH_MS'     THEN 'a2a'

  -- ── orchestration ─────────────────────────────────────────────────────────
  WHEN 'ORCHESTRATOR_SCAN_BATCH_LIMIT'       THEN 'orchestration'
  WHEN 'ORCHESTRATOR_STALL_THRESHOLD_HOURS'  THEN 'orchestration'
  WHEN 'ORCHESTRATOR_STALL_BATCH_LIMIT'      THEN 'orchestration'
  WHEN 'ORCHESTRATOR_OFFER_REAP_MS'          THEN 'orchestration'
  WHEN 'ORCHESTRATOR_POKE_IDLE_MIN'          THEN 'orchestration'
  WHEN 'ORCHESTRATOR_POKE_STORM_CAP'         THEN 'orchestration'
  WHEN 'ORCHESTRATOR_MAX_INFLIGHT_OFFERS'    THEN 'orchestration'
  WHEN 'ORCHESTRATOR_SHUTDOWN_DRAIN_MS'      THEN 'orchestration'
  WHEN 'ORCHESTRATOR_IMPLICIT_GATE_POLL_MS'  THEN 'orchestration'
  WHEN 'ORCHESTRATOR_ENHANCER_REVISE_MS'     THEN 'orchestration'
  WHEN 'ORCHESTRATOR_RECONCILER_MS'          THEN 'orchestration'
  WHEN 'ORCHESTRATOR_STALE_ROW_REAPER_MS'    THEN 'orchestration'
  WHEN 'ORCHESTRATOR_STUCK_WORKER_MS'        THEN 'orchestration'
  WHEN 'ORCHESTRATOR_HEARTBEAT_MS'           THEN 'orchestration'
  WHEN 'ORCHESTRATOR_OFFER_CLAIM_ENABLED'    THEN 'orchestration'

  -- ── agency ────────────────────────────────────────────────────────────────
  WHEN 'AGENCY_OFFER_CLAIM_ENABLED'          THEN 'agency'

  -- ── system (pause / spawn tunables) ──────────────────────────────────────
  WHEN 'PAUSE_FAILURE_THRESHOLD'             THEN 'system'
  WHEN 'PAUSE_BASE_BACKOFF_MS'               THEN 'system'
  WHEN 'PAUSE_BACKOFF_MULTIPLIER'            THEN 'system'
  WHEN 'PAUSE_MAX_BACKOFF_MS'                THEN 'system'
  WHEN 'SPAWN_PROVIDER_MAX_ATTEMPTS'         THEN 'system'

  -- ── ui ────────────────────────────────────────────────────────────────────
  WHEN 'AGENTHIVE_COCKPIT_LAYOUT'            THEN 'ui'

  ELSE category  -- leave unknown rows at their current value (DEFAULT 'uncategorized')
END;

COMMIT;
