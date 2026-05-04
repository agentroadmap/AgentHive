-- Migration 098: P773 — route cooldown_until column + index
--
-- Adds the cooldown_until column to model_routes used by Layer 6
-- of resolveModelRoute(). P721 writes cooldown_until = NOW() + '5 min'
-- when upstream responds with a usage-cap exit code.
--
-- Layer 6 WHERE clause added in agent-spawner.ts:
--   AND (mr.cooldown_until IS NULL OR mr.cooldown_until <= NOW())
--
-- After cooldown_until elapses, the route becomes eligible again
-- with no manual intervention (AC-5).

BEGIN;

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_model_routes_cooldown
  ON roadmap.model_routes (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

COMMENT ON COLUMN roadmap.model_routes.cooldown_until IS
  'P773/P721: set to NOW()+5min when upstream returns a usage-cap signal. NULL means no cooldown active.';

COMMIT;
