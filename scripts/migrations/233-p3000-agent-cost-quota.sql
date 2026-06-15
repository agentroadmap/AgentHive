-- P3000: Per-agent cost quota dimensions and admission-control tables.
--
-- Creates roadmap_workforce.agent_cost_quota to store per-agent, per-route,
-- per-provider, per-project, and per-window spend policy. Referenced by the
-- cost-quota admission module at claim and dispatch time.
--
-- The fair_share_debt and quota_metric_event tables are already present
-- (they were created ahead of this migration). This migration only adds the
-- policy table and the running-spend view.

-- agent_cost_quota: one row per quota scope per agent.
-- Multiple rows for the same agent_identity are AND-ed (all must pass).
CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_cost_quota (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_identity      text NOT NULL
    REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE,
  -- Scope dimension: what this row limits.
  --   per-agent    = total spend for this identity
  --   per-route    = spend via a specific model/route
  --   per-provider = spend via a provider (anthropic, openai …)
  --   per-project  = spend for a project tenant
  --   per-window   = additional time-windowed constraint
  quota_scope         text NOT NULL
    CHECK (quota_scope IN ('per-agent','per-route','per-provider','per-project','per-window')),
  -- scope_key: identifies the target of the limit.
  --   per-route    → route/model slug  (e.g. 'claude-opus-4-8')
  --   per-provider → provider name     (e.g. 'anthropic')
  --   per-project  → project slug      (e.g. 'georgia-singer')
  --   per-window   → window_kind value (e.g. 'daily')
  --   per-agent    → agent_identity    (echoed for join convenience)
  scope_key           text NOT NULL DEFAULT '',
  -- Heterogeneous pricing: token cost for the associated model/route.
  -- Null = inherit from model_metadata or default to 0.
  cost_per_token_usd  numeric(18,12),
  -- Hard budget cap per calendar day (UTC midnight reset).
  quota_usd_per_day   numeric(12,6),
  -- Hard budget cap per window_kind window.
  quota_usd_per_window numeric(12,6),
  -- Window for quota_usd_per_window.
  window_kind         text CHECK (window_kind IN ('5h','daily','weekly','monthly')),
  -- Offer dispatch priority tier (1=critical, 5=nice-to-have).
  -- Used by fair-share scheduler when ranking competing agents.
  priority_tier       smallint NOT NULL DEFAULT 3
    CHECK (priority_tier BETWEEN 1 AND 5),
  -- Reserved headroom percentage (0–100) held back for starvation recovery.
  reserved_headroom_pct numeric(5,2) NOT NULL DEFAULT 5.0
    CHECK (reserved_headroom_pct >= 0 AND reserved_headroom_pct <= 100),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_workforce.agent_cost_quota IS
  'P3000: Per-agent cost quota policies. Multiple rows per agent are AND-ed. '
  'Admission control checks cumulative spend from agent_budget_ledger against '
  'quota_usd_per_day and quota_usd_per_window before claiming or dispatching.';

CREATE INDEX IF NOT EXISTS idx_agent_cost_quota_identity
  ON roadmap_workforce.agent_cost_quota (agent_identity)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_agent_cost_quota_scope
  ON roadmap_workforce.agent_cost_quota (quota_scope, scope_key)
  WHERE is_active;

-- Validate that no quota row is completely unconstrained (must have at least
-- one numeric limit so the row is meaningful).
ALTER TABLE roadmap_workforce.agent_cost_quota
  ADD CONSTRAINT agent_cost_quota_has_limit
    CHECK (
      quota_usd_per_day IS NOT NULL
      OR quota_usd_per_window IS NOT NULL
      OR cost_per_token_usd IS NOT NULL
    );

-- View: running daily spend per agent from the existing budget ledger.
-- Used by the admission-control module without a full table scan.
CREATE OR REPLACE VIEW roadmap_workforce.v_agent_daily_spend AS
  SELECT
    agent_identity,
    SUM(cost_usd) AS spent_today_usd,
    COUNT(*)      AS runs_today
  FROM roadmap_efficiency.agent_budget_ledger
  WHERE recorded_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
  GROUP BY agent_identity;

COMMENT ON VIEW roadmap_workforce.v_agent_daily_spend IS
  'P3000: Today''s cumulative cost per agent (UTC day boundary). '
  'Joined by cost-quota admission control to check quota_usd_per_day.';
