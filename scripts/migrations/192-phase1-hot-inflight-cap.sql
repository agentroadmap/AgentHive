-- Phase 1: hot-configurable global in-flight work-offer cap.
--
-- Moves the backpressure cap from the AGENTHIVE_MAX_INFLIGHT_OFFERS env const
-- (read once at process boot → required an orchestrator restart to change) to
-- the ORCHESTRATOR_MAX_INFLIGHT_OFFERS runtime flag, which post-work-offer.ts
-- now reads per call via the config resolver (cached + cleared on
-- runtime_flag_changed NOTIFY). After this, the cap is changed live with:
--   UPDATE core.runtime_flag SET value_jsonb='8'
--    WHERE flag_name='ORCHESTRATOR_MAX_INFLIGHT_OFFERS';
-- and takes effect on the next dispatch — NO restart.
--
-- Seed value = 5 to match the current operational cap (AGENTHIVE_MAX_INFLIGHT_OFFERS=5),
-- so behavior is identical at cutover. Idempotent.

INSERT INTO core.runtime_flag (flag_name, value_jsonb, description, scope, lifecycle_status)
VALUES (
  'ORCHESTRATOR_MAX_INFLIGHT_OFFERS',
  '5'::jsonb,
  'Max global in-flight work offers (backpressure cap); 0=disabled. Hot-reloadable via runtime_flag_changed.',
  'global',
  'active'
)
ON CONFLICT (flag_name) DO NOTHING;
