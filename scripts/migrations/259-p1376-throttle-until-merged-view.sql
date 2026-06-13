-- P1376-AC1: Unified throttle view merging proactive and reactive cooldowns.
--
-- Creates a view throttle_until_merged that computes GREATEST across:
-- - Proactive (agency_capacity.reset_at): hard throttle window set by capacity monitoring
-- - Reactive (model_routes.cooldown_until): transient backoff from 429/quota errors
--
-- Semantics: returns the later of the two timestamps, defaulting to now() if either is missing.
-- Used by resolver to enforce a single WHERE computed_throttle_until > NOW() predicate
-- instead of checking both sources separately.
--
-- AC-1 verified: view includes all columns from agency_capacity + computed_throttle_until.
-- AC-5 amended: future throttle decisions will log throttle_source='proactive|reactive|both'.

BEGIN;

-- Create the view if it doesn't exist. Idempotent.
CREATE OR REPLACE VIEW roadmap_workforce.throttle_until_merged AS
SELECT
  ac.provider,
  ac.model,
  ac.agency_id,
  ac.requests_remaining,
  ac.tokens_remaining,
  ac.requests_limit,
  ac.tokens_limit,
  ac.reset_at,
  ac.last_sampled_at,
  ac.burn_rate_per_sec,
  ac.throttle_action,
  ac.updated_at,
  ac.headroom_pct,
  ac.p_skip,
  mr.cooldown_until,
  -- Compute the later (GREATEST) of the two throttle windows.
  -- COALESCE to now() if either source is null (no active throttle).
  GREATEST(
    COALESCE(ac.reset_at, now()),
    COALESCE(mr.cooldown_until, now())
  ) AS computed_throttle_until,
  -- Log which throttle source(s) contributed to the final window (AC-5).
  CASE
    WHEN ac.reset_at IS NOT NULL AND mr.cooldown_until IS NOT NULL
      AND ac.reset_at > mr.cooldown_until THEN 'proactive'
    WHEN ac.reset_at IS NOT NULL AND mr.cooldown_until IS NOT NULL
      AND mr.cooldown_until > ac.reset_at THEN 'reactive'
    WHEN ac.reset_at IS NOT NULL AND mr.cooldown_until IS NOT NULL THEN 'both'
    WHEN ac.reset_at IS NOT NULL THEN 'proactive'
    WHEN mr.cooldown_until IS NOT NULL THEN 'reactive'
    ELSE 'none'
  END AS throttle_source
FROM roadmap_workforce.agency_capacity ac
LEFT JOIN roadmap.model_routes mr
  ON mr.route_provider = ac.provider
  AND mr.model_name = ac.model
WHERE ac.agency_id IS NOT NULL;

COMMENT ON VIEW roadmap_workforce.throttle_until_merged IS
  'P1376-AC1: Unified view for resolver throttle decisions. Merges proactive (agency_capacity.reset_at) and reactive (model_routes.cooldown_until) cooldowns using GREATEST. Includes computed_throttle_until and throttle_source for audit.';

COMMIT;
