-- P3782: Add category column to core.runtime_flag + backfill with 16-value taxonomy.
--
-- Replaces the legacy database/migrations/254-p3782-runtime-flag-category.sql
-- (which was placed in the wrong directory and used the old 11-value taxonomy).
--
-- The taxonomy is the CLOSED 16-member set defined in
-- src/shared/runtime/config-categories.ts.  Any new category requires a code
-- change to that file AND a migration to extend the CHECK constraint here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS are safe to re-run.
-- fn_runtime_flag_notify trigger is untouched.

BEGIN;

ALTER TABLE core.runtime_flag
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';

-- Drop and recreate the CHECK so this migration is idempotent on re-run.
-- 'general' is included as a backward-compat catch-all for flags not yet classified.
ALTER TABLE core.runtime_flag
  DROP CONSTRAINT IF EXISTS runtime_flag_category_chk;
ALTER TABLE core.runtime_flag
  DROP CONSTRAINT IF EXISTS runtime_flag_category_check;

ALTER TABLE core.runtime_flag
  ADD CONSTRAINT runtime_flag_category_chk CHECK (category IN (
    'database',
    'connection_pool',
    'vault_secret',
    'mcp_endpoint',
    'orchestrator',
    'dispatch',
    'liaison',
    'pause_backoff',
    'provider_quota',
    'adaptive_matcher',
    'gate_governance',
    'multi_tenant',
    'model_routing',
    'audit',
    'ui_ux',
    'diagnostic',
    'general'
  ));

-- Backfill: set category for all known flag names.
-- Any row whose flag_name is not in the list keeps 'diagnostic' (its DEFAULT).
UPDATE core.runtime_flag
SET category = CASE flag_name

  -- ── database ─────────────────────────────────────────────────────────────
  WHEN 'AGENTHIVE_CONTROL_DSN'              THEN 'database'
  WHEN 'AGENTHIVE_CONTROL_HOST'             THEN 'database'
  WHEN 'AGENTHIVE_CONTROL_PORT'             THEN 'database'
  WHEN 'AGENTHIVE_CONTROL_DB'               THEN 'database'

  -- ── connection_pool ───────────────────────────────────────────────────────
  WHEN 'PGBOUNCER_HOST'                     THEN 'connection_pool'
  WHEN 'PGBOUNCER_PORT'                     THEN 'connection_pool'
  WHEN 'PGBOUNCER_POOL_SIZE'                THEN 'connection_pool'
  WHEN 'PGBOUNCER_KEEPALIVE_MS'             THEN 'connection_pool'

  -- ── mcp_endpoint ─────────────────────────────────────────────────────────
  WHEN 'A2A_HOST_LISTEN_REFRESH_MS'         THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_PG_RECONNECT_MS'           THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_SHUTDOWN_TIMEOUT_MS'       THEN 'mcp_endpoint'
  WHEN 'A2A_HOST_PRESENCE_REFRESH_MS'       THEN 'mcp_endpoint'

  -- ── orchestrator ─────────────────────────────────────────────────────────
  WHEN 'ORCHESTRATOR_SCAN_BATCH_LIMIT'       THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALL_THRESHOLD_HOURS'  THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALL_BATCH_LIMIT'      THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_OFFER_REAP_MS'          THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_POKE_IDLE_MIN'          THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_POKE_STORM_CAP'         THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_MAX_INFLIGHT_OFFERS'    THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_SHUTDOWN_DRAIN_MS'      THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_IMPLICIT_GATE_POLL_MS'  THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_ENHANCER_REVISE_MS'     THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_RECONCILER_MS'          THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STALE_ROW_REAPER_MS'    THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_STUCK_WORKER_MS'        THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_HEARTBEAT_MS'           THEN 'orchestrator'
  WHEN 'ORCHESTRATOR_OFFER_CLAIM_ENABLED'    THEN 'orchestrator'

  -- ── dispatch ─────────────────────────────────────────────────────────────
  WHEN 'USE_OFFER_DISPATCH'                  THEN 'dispatch'
  WHEN 'AGENCY_OFFER_CLAIM_ENABLED'          THEN 'dispatch'
  WHEN 'DISPATCH_LOOP_THRESHOLD_PER_HOUR'    THEN 'dispatch'
  WHEN 'GATEWAY_WAKE_TIMEOUT_MS'             THEN 'dispatch'

  -- ── liaison ───────────────────────────────────────────────────────────────
  WHEN 'LIAISON_CONTEXT_REFRESH_MS'          THEN 'liaison'
  WHEN 'LIAISON_LLM_TIMEOUT_MS'              THEN 'liaison'
  WHEN 'LIAISON_SELF_CLAIM_AGENCIES'         THEN 'liaison'

  -- ── pause_backoff ─────────────────────────────────────────────────────────
  WHEN 'PAUSE_FAILURE_THRESHOLD'             THEN 'pause_backoff'
  WHEN 'PAUSE_BASE_BACKOFF_MS'               THEN 'pause_backoff'
  WHEN 'PAUSE_BACKOFF_MULTIPLIER'            THEN 'pause_backoff'
  WHEN 'PAUSE_MAX_BACKOFF_MS'                THEN 'pause_backoff'
  WHEN 'SAGA_REPAIR_INTERVAL_MS'             THEN 'pause_backoff'
  WHEN 'SAGA_MAX_ATTEMPTS'                   THEN 'pause_backoff'
  WHEN 'SAGA_MAX_BACKOFF_HOURS'              THEN 'pause_backoff'

  -- ── provider_quota ────────────────────────────────────────────────────────
  WHEN 'SPAWN_PROVIDER_MAX_ATTEMPTS'         THEN 'provider_quota'
  WHEN 'PROVIDER_HEALTH_CACHE_TTL_MS'        THEN 'provider_quota'
  WHEN 'NOTIFICATION_MAX_ATTEMPTS'           THEN 'provider_quota'
  WHEN 'NOTIFICATION_POLL_MS'                THEN 'provider_quota'
  WHEN 'NOTIFICATION_BATCH_SIZE'             THEN 'provider_quota'

  -- ── gate_governance ───────────────────────────────────────────────────────
  WHEN 'GATE_CONVERGENCE_MAX_BLOCKING'       THEN 'gate_governance'
  WHEN 'GATE_CONVERGENCE_MAX_RUNS_PER_ROLE'  THEN 'gate_governance'

  -- ── multi_tenant ──────────────────────────────────────────────────────────
  WHEN 'ENABLE_MULTI_TENANT'                 THEN 'multi_tenant'
  WHEN 'AGENT_PROPOSAL_LEASE_TTL_MS'         THEN 'multi_tenant'

  -- ── model_routing ─────────────────────────────────────────────────────────
  WHEN 'DEFAULT_PROVIDER'                    THEN 'model_routing'
  WHEN 'KB_EMBEDDING_MODEL'                  THEN 'model_routing'

  -- ── audit ─────────────────────────────────────────────────────────────────
  WHEN 'ENABLE_AUDIT_LOG'                    THEN 'audit'

  -- ── ui_ux ─────────────────────────────────────────────────────────────────
  WHEN 'AGENTHIVE_COCKPIT_LAYOUT'            THEN 'ui_ux'

  -- ── gate_governance (extended) ────────────────────────────────────────────
  WHEN 'AGENTHIVE_GATE_AC_INVARIANT_ENABLED'  THEN 'gate_governance'
  WHEN 'PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC' THEN 'gate_governance'

  -- ── orchestrator (extended) ───────────────────────────────────────────────
  WHEN 'ORCHESTRATOR_TARGET_QUOTA_PCT'        THEN 'orchestrator'

  -- ── dispatch (extended) ──────────────────────────────────────────────────
  WHEN 'COLLABORATION_LEASE_TTL_MS'           THEN 'dispatch'
  WHEN 'NOTIFICATION_POLL_INTERVAL_MS'        THEN 'dispatch'
  WHEN 'SAGA_REPAIR_MAX_ATTEMPTS'             THEN 'pause_backoff'
  WHEN 'SAGA_REPAIR_MAX_BACKOFF_HOURS'        THEN 'pause_backoff'

  -- ── multi_tenant (extended) ───────────────────────────────────────────────
  WHEN 'FEDERATION_HEALTH_QUARANTINE_THRESHOLD' THEN 'multi_tenant'
  WHEN 'FEDERATION_SYNC_POLL_INTERVAL_MS'     THEN 'multi_tenant'

  -- ── mcp_endpoint (extended) ──────────────────────────────────────────────
  WHEN 'TRANSPORT_WAKE_TIMEOUT_MS'            THEN 'mcp_endpoint'

  -- ── provider_quota (extended) ─────────────────────────────────────────────
  WHEN 'PROVIDER_HEALTH_TTL_MS'               THEN 'provider_quota'

  -- ── diagnostic ────────────────────────────────────────────────────────────
  WHEN 'FEDERATION_SYNC_POLL_MS'             THEN 'diagnostic'
  WHEN 'FEDERATION_QUARANTINE_THRESHOLD'     THEN 'diagnostic'
  WHEN 'FEDERATION_STALE_PEER_MS'            THEN 'diagnostic'
  WHEN 'FEDERATION_PING_TIMEOUT_MS'          THEN 'diagnostic'

  ELSE category  -- preserve any existing category value (or DEFAULT 'general')
END;

COMMIT;
