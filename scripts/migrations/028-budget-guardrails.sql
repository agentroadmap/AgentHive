-- Migration 028: Budget Guardrails
--
-- Seeds all three budget layers:
--   1. budget_allowance  — $10 per enabled model (scope='global', owner='system')
--   2. budget_circuit_breaker — global trip at $100 total spend
--   3. spending_caps     — per active LLM agent: $10/day, $100/month
--
-- Intent: each model can consume up to $10 before its allowance is exhausted;
-- the circuit breaker halts everything at $100 cumulative; individual agents
-- are also rate-limited to prevent a single runaway agent from consuming
-- the full budget before the breaker fires.

BEGIN;

-- ── 1. Per-model budget allowances ($10 each) ─────────────────────────────────
-- One row per enabled model. scope_ref = model_name so the spending logger
-- can join on it. owner_identity = 'system' (tool agent, always registered).

INSERT INTO roadmap_efficiency.budget_allowance
  (label, owner_identity, scope, scope_ref, allocated_usd)
SELECT
  mr.model_name                            AS label,
  'system'                                 AS owner_identity,
  'global'                                 AS scope,
  mr.model_name                            AS scope_ref,
  10.00                                    AS allocated_usd
FROM (
  SELECT DISTINCT model_name
  FROM roadmap.model_routes
  WHERE is_enabled = true
) mr
ON CONFLICT DO NOTHING;

-- ── 2. Global circuit breaker ($100 total) ────────────────────────────────────
-- status='armed': monitors spend, trips automatically when threshold_config
-- conditions are met by the spending enforcement layer.
-- threshold_config encodes:
--   total_usd      — hard ceiling across all agents/models combined
--   per_model_usd  — soft ceiling per model (matches budget_allowance allocation)
--   daily_usd      — per-day trip to catch sudden spikes

INSERT INTO roadmap_efficiency.budget_circuit_breaker
  (circuit_name, status, threshold_config)
VALUES
  ('global-spend', 'armed', '{
    "total_usd":     100,
    "per_model_usd":  10,
    "daily_usd":      20
  }')
ON CONFLICT (circuit_name) DO UPDATE
  SET threshold_config = EXCLUDED.threshold_config,
      status           = 'armed',
      tripped_at       = NULL,
      reset_at         = NULL;

-- ── 3. Per-agent spending caps ────────────────────────────────────────────────
-- Covers all active LLM agents in the registry.
-- daily = $10 (matches per-model allowance — one agent shouldn't hit more than
-- one model's quota per day); monthly = $100 (matches global circuit breaker).

INSERT INTO roadmap_efficiency.spending_caps
  (agent_identity, daily_limit_usd, monthly_limit_usd)
SELECT
  agent_identity,
  10.00   AS daily_limit_usd,
  100.00  AS monthly_limit_usd
FROM agent_registry
WHERE agent_type = 'llm'
  AND status     = 'active'
ON CONFLICT (agent_identity) DO UPDATE
  SET daily_limit_usd   = EXCLUDED.daily_limit_usd,
      monthly_limit_usd = EXCLUDED.monthly_limit_usd,
      updated_at        = now();

COMMIT;
