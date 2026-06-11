-- P1365: Add missing agency_capacity columns for headroom tracking
-- Adds headroom_pct and p_skip for soft-throttle decision-making
--
-- headroom_pct: minimum of requests/tokens headroom as a percentage (0-100)
-- p_skip: skip probability for stochastic soft-throttle (0-1)

ALTER TABLE roadmap_workforce.agency_capacity
  ADD COLUMN IF NOT EXISTS headroom_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS p_skip numeric(5,3) NOT NULL DEFAULT 0.0
    CHECK (p_skip >= 0 AND p_skip <= 1);

COMMENT ON COLUMN roadmap_workforce.agency_capacity.headroom_pct IS
  'P1365: Minimum of requests/tokens headroom percentage (0-100). Null if capacity data unavailable. Used by soft-throttle backoff logic.';

COMMENT ON COLUMN roadmap_workforce.agency_capacity.p_skip IS
  'P1365: Skip probability for soft-throttle: stochastic rejection rate applied to spawns. Range [0, 1]. 0 = no throttle, 1 = hard-throttle equivalent.';
