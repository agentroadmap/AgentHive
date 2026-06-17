-- P3782 AC-1: Add category column to core.runtime_flag
-- Taxonomy: 16 closed values matching ConfigCategory in config.ts
-- Default 'general' is intentionally NOT in the check list — backfill below
-- assigns every known flag a real category before the check is tightened.

BEGIN;

ALTER TABLE core.runtime_flag
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';

-- Backfill known flags to their canonical categories
UPDATE core.runtime_flag SET category = CASE flag_name
  WHEN 'USE_OFFER_DISPATCH'              THEN 'dispatch'
  WHEN 'ORCHESTRATOR_OFFER_CLAIM_ENABLED' THEN 'dispatch'
  WHEN 'AGENCY_OFFER_CLAIM_ENABLED'      THEN 'dispatch'
  WHEN 'ENABLE_MULTI_TENANT'             THEN 'multi_tenant'
  WHEN 'ENABLE_AUDIT_LOG'                THEN 'audit'
  WHEN 'A2A_HOST_LISTEN_REFRESH_MS'      THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_PG_RECONNECT_MS'        THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_SHUTDOWN_TIMEOUT_MS'    THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_PRESENCE_REFRESH_MS'    THEN 'mcp_endpoint'
  WHEN 'LIAISON_CONTEXT_REFRESH_MS'      THEN 'liaison'
  WHEN 'ORCHESTRATOR_SCAN_BATCH_LIMIT'   THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALL_THRESHOLD_HOURS' THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALL_BATCH_LIMIT'  THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_OFFER_REAP_MS'      THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_POKE_IDLE_MIN'      THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_POKE_STORM_CAP'     THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_MAX_INFLIGHT_OFFERS' THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_SHUTDOWN_DRAIN_MS'  THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_IMPLICIT_GATE_POLL_MS' THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_ENHANCER_REVISE_MS' THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_RECONCILER_MS'      THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALE_ROW_REAPER_MS' THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STUCK_WORKER_MS'    THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_HEARTBEAT_MS'       THEN 'orchestrator'
  WHEN 'PAUSE_FAILURE_THRESHOLD'         THEN 'pause_backoff'
  WHEN 'PAUSE_BASE_BACKOFF_MS'           THEN 'pause_backoff'
  WHEN 'PAUSE_BACKOFF_MULTIPLIER'        THEN 'pause_backoff'
  WHEN 'PAUSE_MAX_BACKOFF_MS'            THEN 'pause_backoff'
  WHEN 'SPAWN_PROVIDER_MAX_ATTEMPTS'     THEN 'provider_quota'
  WHEN 'AGENTHIVE_COCKPIT_LAYOUT'        THEN 'ui_ux'
  ELSE category
END;

-- Add check constraint after backfill so rows with 'general' remain valid
-- (operator-seeded unknown flags keep 'general' until classified)
ALTER TABLE core.runtime_flag
  ADD CONSTRAINT runtime_flag_category_check CHECK (category IN (
    'database', 'connection_pool', 'vault_secret', 'mcp_endpoint',
    'orchestrator', 'dispatch', 'liaison', 'pause_backoff',
    'provider_quota', 'adaptive_matcher', 'gate_governance', 'multi_tenant',
    'model_routing', 'audit', 'ui_ux', 'diagnostic', 'general'
  ));

COMMIT;
