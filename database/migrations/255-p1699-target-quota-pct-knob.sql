-- P1699 Phase 3 AC-1: target_quota_pct knob for the AIMD capacity controller.
--
-- Two parts of the knob, both meter-INDEPENDENT (pure config plumbing):
--   1. Per-agency override column on provider_registry.
--   2. Global hot-reloadable runtime flag ORCHESTRATOR_TARGET_QUOTA_PCT (0.98).
--
-- The effective-cap FORMULA that consumes this knob
-- (effective_cap = min(max_in_flight, floor(remaining_quota * target_quota_pct)))
-- additionally needs the live usage meter (P1859 agent_usage_snapshot.quota_remaining
-- via getLatestQuotaSnapshot()). The reader path exists; the snapshot table is
-- simply empty until a spawn records into it. This migration ships only the knob
-- itself, which is fully exercisable in unit tests with a supplied meter signal.

-- 1. Per-agency override. NULL = "use the global flag / default".
--    Range (0, 1]: 1.0 = use full remaining quota, smaller = leave headroom.
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS target_quota_pct_override numeric(4,3)
    CHECK (target_quota_pct_override IS NULL
           OR (target_quota_pct_override > 0 AND target_quota_pct_override <= 1));

COMMENT ON COLUMN roadmap_workforce.provider_registry.target_quota_pct_override IS
  'P1699 AC-1: per-agency override for the AIMD target_quota_pct knob. Range (0,1]. '
  'NULL => fall through to the global ORCHESTRATOR_TARGET_QUOTA_PCT runtime flag (default 0.98). '
  'Consumed by resolveTargetQuotaPct() in capacity-controller.ts.';

-- 2. Global hot-reloadable knob. core.runtime_flag fires runtime_flag_changed
--    NOTIFY on write (trg_runtime_flag_notify), so RuntimeConfig invalidates its
--    cache without a restart. Idempotent: don't clobber an operator-tuned value.
INSERT INTO core.runtime_flag (flag_name, value_jsonb, description, scope, lifecycle_status)
VALUES (
  'ORCHESTRATOR_TARGET_QUOTA_PCT',
  '0.98'::jsonb,
  'P1699 AC-1: global default fraction of remaining quota the AIMD controller is allowed to spend (0,1]. Hot-reloadable. Per-agency override: provider_registry.target_quota_pct_override.',
  'global',
  'active'
)
ON CONFLICT (flag_name) DO NOTHING;
