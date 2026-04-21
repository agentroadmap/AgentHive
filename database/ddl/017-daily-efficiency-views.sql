-- P191: Daily Efficiency Views and Combined Metrics Dashboard
-- Creates daily-granularity metrics views for operational visibility.
-- Source: metrics.token_efficiency (columns: recorded_at, agent_role, model,
--          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
--          cache_hit_rate, cost_microdollars).
--
-- NOTE: Column naming differs from original proposal P191 spec:
--   - recorded_at (not ts)
--   - agent_role (not agent_identity) — aliased as agent_identity in views
--   - model (not model_name) — aliased as model_name in views
--   - cost_microdollars (not cost_usd) — converted to USD in views
--   - invocations (not call_count)
--
-- Applied directly to DB 2026-04-14; this DDL is the reproducible migration artifact.

-- 1. Daily efficiency by agent and model
CREATE OR REPLACE VIEW metrics.v_daily_efficiency AS
SELECT
  date_trunc('day', recorded_at) AS day,
  agent_role AS agent_identity,
  model AS model_name,
  agent_role,
  model,
  count(*) AS invocations,
  sum(input_tokens) AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(cache_read_tokens) AS total_cache_read_tokens,
  sum(cache_write_tokens) AS total_cache_write_tokens,
  CASE
    WHEN sum(input_tokens + cache_read_tokens) > 0
      THEN round(100.0 * sum(cache_read_tokens)::numeric
           / sum(input_tokens + cache_read_tokens)::numeric, 1)
    ELSE 0.0
  END AS cache_hit_rate_pct,
  round(avg(cache_hit_rate), 3) AS avg_cache_hit_rate,
  sum(cost_microdollars) AS total_cost_microdollars,
  round(sum(cost_microdollars) / 1000000::numeric, 4) AS total_cost_usd,
  CASE
    WHEN sum(input_tokens + output_tokens) > 0
      THEN round(sum(cost_microdollars) / 1000000::numeric
           / sum(input_tokens + output_tokens)::numeric * 1000::numeric, 6)
    ELSE 0::numeric
  END AS cost_per_1k_tokens
FROM metrics.token_efficiency
GROUP BY date_trunc('day', recorded_at), agent_role, model
ORDER BY day DESC, total_input_tokens DESC;

-- 2. Combined daily + weekly metrics
CREATE OR REPLACE VIEW metrics.v_combined_metrics AS
SELECT
  'daily'::text AS period,
  v_daily_efficiency.day AS period_start,
  v_daily_efficiency.agent_identity,
  v_daily_efficiency.model_name,
  v_daily_efficiency.agent_role,
  v_daily_efficiency.model,
  v_daily_efficiency.invocations,
  v_daily_efficiency.total_input_tokens,
  v_daily_efficiency.total_output_tokens,
  v_daily_efficiency.total_cache_read_tokens,
  v_daily_efficiency.cache_hit_rate_pct,
  v_daily_efficiency.total_cost_usd,
  v_daily_efficiency.cost_per_1k_tokens
FROM metrics.v_daily_efficiency
UNION ALL
SELECT
  'weekly'::text AS period,
  v_weekly_efficiency.week_start AS period_start,
  v_weekly_efficiency.agent_identity,
  v_weekly_efficiency.model_name,
  v_weekly_efficiency.agent_role,
  v_weekly_efficiency.model,
  v_weekly_efficiency.invocations,
  v_weekly_efficiency.total_input_tokens,
  v_weekly_efficiency.total_output_tokens,
  v_weekly_efficiency.total_cache_read_tokens,
  v_weekly_efficiency.cache_hit_rate_pct,
  v_weekly_efficiency.total_cost_usd,
  v_weekly_efficiency.cost_per_1k_tokens
FROM metrics.v_weekly_efficiency
ORDER BY 2 DESC, 12 DESC;

-- 3. Agent lifetime ROI analysis
CREATE OR REPLACE VIEW metrics.v_agent_performance AS
SELECT
  agent_role AS agent_identity,
  model AS model_name,
  agent_role,
  model,
  sum(invocations) AS total_invocations,
  sum(total_input_tokens) AS lifetime_input_tokens,
  sum(total_output_tokens) AS lifetime_output_tokens,
  sum(total_cache_read_tokens) AS lifetime_cache_read_tokens,
  CASE
    WHEN sum(total_input_tokens + total_cache_read_tokens) > 0
      THEN round(100.0 * sum(total_cache_read_tokens)
           / sum(total_input_tokens + total_cache_read_tokens), 1)
    ELSE 0.0
  END AS lifetime_cache_hit_pct,
  round(avg(avg_cache_hit_rate), 3) AS overall_cache_hit_rate,
  sum(total_cost_usd) AS lifetime_cost_usd,
  round(sum(total_cost_usd) / nullif(sum(invocations), 0::numeric), 6) AS cost_per_invocation,
  round((sum(total_input_tokens) + sum(total_output_tokens))
        / nullif(sum(total_cost_usd), 0::numeric), 0) AS tokens_per_dollar,
  row_number() OVER (ORDER BY sum(total_cost_usd) DESC) AS efficiency_rank
FROM metrics.v_daily_efficiency
GROUP BY agent_role, model
ORDER BY lifetime_cost_usd DESC;
