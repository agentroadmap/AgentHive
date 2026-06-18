-- P3787: Seed 16 runtime flags for hardcoded-constant migration (first wave)
--
-- All seeds use ON CONFLICT DO NOTHING so:
--   a) A fresh deploy with zero flag rows behaves identically to old code
--      (defaultValue in FlagKeys == original literal).
--   b) Running this migration twice is safe.
--   c) Operators who already customised a flag value keep their value.
--
-- DB category values must match the CHECK constraint on core.runtime_flag.category.
-- TypeScript FlagKeys.category (orchestration/system/a2a/agency) is a separate taxonomy.

BEGIN;

-- ── orchestrator (dispatch/gate convergence/lease) ────────────────────────────

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'DISPATCH_LOOP_THRESHOLD_PER_HOUR', '6', 'global', 'active',
  'orchestrator',
  'Max dispatch runs per (proposal, role) per hour before circuit-breaker pauses the proposal'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'GATE_CONVERGENCE_MAX_BLOCKING', '3', 'global', 'active',
  'orchestrator',
  'Max cumulative blocking reviews since last state/maturity transition before proposal is paused'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'GATE_CONVERGENCE_MAX_RUNS_PER_ROLE', '8', 'global', 'active',
  'orchestrator',
  'Max dispatch runs per role since last state/maturity transition before proposal is paused'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'AGENT_PROPOSAL_LEASE_TTL_MS', '1800000', 'global', 'active',
  'orchestrator',
  'Default lease TTL (ms) for in-memory agent proposal leases (30 min)'
) ON CONFLICT (flag_name) DO NOTHING;

-- ── general (system-level timers/intervals) ───────────────────────────────────

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'FEDERATION_SYNC_POLL_INTERVAL_MS', '30000', 'global', 'active',
  'general',
  'Interval (ms) between federation peer sync polls'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'FEDERATION_HEALTH_QUARANTINE_THRESHOLD', '3', 'global', 'active',
  'general',
  'Consecutive health-check failures before a peer is quarantined'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'FEDERATION_PING_TIMEOUT_MS', '5000', 'global', 'active',
  'general',
  'Timeout (ms) for federation peer ping/health-check HTTP request'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'SAGA_REPAIR_INTERVAL_MS', '60000', 'global', 'active',
  'general',
  'Interval (ms) between saga repair-worker cycles'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'SAGA_REPAIR_MAX_ATTEMPTS', '10', 'global', 'active',
  'general',
  'Max retry attempts for a failed saga item before escalation'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'SAGA_REPAIR_MAX_BACKOFF_HOURS', '24', 'global', 'active',
  'general',
  'Maximum backoff cap (hours) for saga repair exponential-backoff'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'NOTIFICATION_POLL_INTERVAL_MS', '30000', 'global', 'active',
  'general',
  'Backstop polling interval (ms) for the notification-queue drain loop'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'NOTIFICATION_BATCH_SIZE', '25', 'global', 'active',
  'general',
  'Max notification rows claimed per drain-loop batch'
) ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'TRANSPORT_WAKE_TIMEOUT_MS', '10000', 'global', 'active',
  'general',
  'Max time (ms) to wait for a transport adapter to wake from offline state'
) ON CONFLICT (flag_name) DO NOTHING;

-- ── model_routing ─────────────────────────────────────────────────────────────

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'PROVIDER_HEALTH_CACHE_TTL_MS', '30000', 'global', 'active',
  'model_routing',
  'TTL (ms) for provider-health cache entries; stale entries are re-probed'
) ON CONFLICT (flag_name) DO NOTHING;

-- ── liaison (A2A timeout) ─────────────────────────────────────────────────────

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'LIAISON_LLM_TIMEOUT_MS', '30000', 'global', 'active',
  'liaison',
  'Default LLM invocation timeout (ms) for liaison agents; per-provider env overrides still take precedence'
) ON CONFLICT (flag_name) DO NOTHING;

-- ── dispatch (agency self-claim allowlist) ────────────────────────────────────

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description)
VALUES (
  'SELF_CLAIM_AGENCIES', '""', 'global', 'active',
  'dispatch',
  'Comma-separated agency identities allowed to self-claim offers; empty = all agencies'
) ON CONFLICT (flag_name) DO NOTHING;

COMMIT;
