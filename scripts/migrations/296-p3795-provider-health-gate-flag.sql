-- Migration 296: P3795 — seed PROVIDER_HEALTH_GATE_ENABLED runtime flag
-- Hard routing gate on P796 async probe results: blocks dispatch to providers
-- whose health status is 'timeout' or 'error'. Fail-open on stale/absent cache.
-- Idempotent: ON CONFLICT (flag_name, scope) DO NOTHING

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description, modified_by_did, owner_did)
VALUES (
  'PROVIDER_HEALTH_GATE_ENABLED',
  'global',
  'true',
  'P3795: when true, dispatch is blocked for providers whose P796 async health probe returns timeout or error. Fail-open on stale/absent cache. Default true.',
  'migration-296',
  'system'
)
ON CONFLICT (flag_name, scope) DO NOTHING;
