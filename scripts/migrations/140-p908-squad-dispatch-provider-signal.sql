-- P908-B: Add provider_signal column to squad_dispatch for cooldown tracking.
-- Records the provider outcome of a spawn: 'rate_limited', 'credit_exhausted',
-- 'failed', or NULL (success). Populated by offer-dispatch-handler after spawn.
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS provider_signal text;
