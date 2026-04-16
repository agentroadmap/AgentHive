-- Migration 024: P191 Daily Efficiency Views (AC-compliant)
-- Updates metrics views created in DDL/017 to match P191 acceptance criteria:
--   AC-2: agent_identity + model_name column aliases
--   AC-3: cache_hit_rate_pct = 100 * cache_read / (input + cache_read)
--   AC-4: cost_per_1k_tokens = (cost_usd / (input + output)) * 1000
--   AC-5: v_combined_metrics with period column ('daily'/'weekly')
--   AC-6: v_agent_performance with efficiency_rank + lifetime_cache_hit_pct

BEGIN;

-- Drop views in dependency order before recreating with new columns
-- (v_combined_metrics and v_agent_performance depend on v_daily/weekly)
DROP VIEW IF EXISTS metrics.v_agent_performance CASCADE;
DROP VIEW IF EXISTS metrics.v_combined_metrics CASCADE;
DROP VIEW IF EXISTS metrics.v_weekly_efficiency CASCADE;
DROP VIEW IF EXISTS metrics.v_daily_efficiency CASCADE;

-- ── v_daily_efficiency ──────────────────────────────────────────────────────
-- AC-2: date, agent_identity, model_name columns
-- AC-3: cache_hit_rate_pct = 100 * cache_read / (input + cache_read)
-- AC-4: cost_per_1k_tokens = (cost_usd / (input + output)) * 1000

CREATE VIEW metrics.v_daily_efficiency AS
SELECT
  date_trunc('day', recorded_at)                          AS day,
  -- AC-2: canonical alias columns
  agent_role                                              AS agent_identity,
  model                                                   AS model_name,
  -- keep original names for backward compat
  agent_role,
  model,
  count(*)                                                AS invocations,
  sum(input_tokens)                                       AS total_input_tokens,
  sum(output_tokens)                                      AS total_output_tokens,
  sum(cache_read_tokens)                                  AS total_cache_read_tokens,
  sum(cache_write_tokens)                                 AS total_cache_write_tokens,
  -- AC-3: cache_hit_rate_pct = 100 * cache_read / (input + cache_read)
  CASE WHEN sum(input_tokens + cache_read_tokens) > 0
    THEN round(
      100.0 * sum(cache_read_tokens)::numeric
      / sum(input_tokens + cache_read_tokens)::numeric,
      1
    )
    ELSE 0.0
  END                                                     AS cache_hit_rate_pct,
  -- legacy column (keep for existing code)
  round(avg(cache_hit_rate), 3)                           AS avg_cache_hit_rate,
  sum(cost_microdollars)                                  AS total_cost_microdollars,
  round(CAST(sum(cost_microdollars) AS numeric) / 1000000, 4) AS total_cost_usd,
  -- AC-4: cost_per_1k_tokens = (cost_usd / (input + output)) * 1000
  CASE WHEN sum(input_tokens + output_tokens) > 0
    THEN round(
      (sum(cost_microdollars)::numeric / 1000000)
      / sum(input_tokens + output_tokens)::numeric
      * 1000,
      6
    )
    ELSE 0
  END                                                     AS cost_per_1k_tokens
FROM metrics.token_efficiency
GROUP BY date_trunc('day', recorded_at), agent_role, model
ORDER BY 1 DESC, total_input_tokens DESC;

COMMENT ON VIEW metrics.v_daily_efficiency IS
  'Daily token efficiency by agent and model. P191: adds agent_identity, model_name aliases, cache_hit_rate_pct, cost_per_1k_tokens.';

-- ── v_weekly_efficiency ─────────────────────────────────────────────────────

CREATE VIEW metrics.v_weekly_efficiency AS
SELECT
  date_trunc('week', recorded_at)                         AS week_start,
  agent_role                                              AS agent_identity,
  model                                                   AS model_name,
  agent_role,
  model,
  count(*)                                                AS invocations,
  sum(input_tokens)                                       AS total_input_tokens,
  sum(output_tokens)                                      AS total_output_tokens,
  sum(cache_read_tokens)                                  AS total_cache_read_tokens,
  sum(cache_write_tokens)                                 AS total_cache_write_tokens,
  CASE WHEN sum(input_tokens + cache_read_tokens) > 0
    THEN round(
      100.0 * sum(cache_read_tokens)::numeric
      / sum(input_tokens + cache_read_tokens)::numeric,
      1
    )
    ELSE 0.0
  END                                                     AS cache_hit_rate_pct,
  round(avg(cache_hit_rate), 3)                           AS avg_cache_hit_rate,
  sum(cost_microdollars)                                  AS total_cost_microdollars,
  round(CAST(sum(cost_microdollars) AS numeric) / 1000000, 4) AS total_cost_usd,
  CASE WHEN sum(input_tokens + output_tokens) > 0
    THEN round(
      (sum(cost_microdollars)::numeric / 1000000)
      / sum(input_tokens + output_tokens)::numeric
      * 1000,
      6
    )
    ELSE 0
  END                                                     AS cost_per_1k_tokens
FROM metrics.token_efficiency
GROUP BY date_trunc('week', recorded_at), agent_role, model
ORDER BY 1 DESC, total_input_tokens DESC;

COMMENT ON VIEW metrics.v_weekly_efficiency IS
  'Weekly token efficiency by agent and model. P191: aligned with v_daily_efficiency column set.';

-- ── v_combined_metrics ──────────────────────────────────────────────────────
-- AC-5: period column with 'daily' and 'weekly' values (UNION ALL structure)

CREATE VIEW metrics.v_combined_metrics AS
SELECT
  'daily'                                                 AS period,
  day                                                     AS period_start,
  agent_identity,
  model_name,
  agent_role,
  model,
  invocations,
  total_input_tokens,
  total_output_tokens,
  total_cache_read_tokens,
  cache_hit_rate_pct,
  total_cost_usd,
  cost_per_1k_tokens
FROM metrics.v_daily_efficiency
UNION ALL
SELECT
  'weekly'                                                AS period,
  week_start                                              AS period_start,
  agent_identity,
  model_name,
  agent_role,
  model,
  invocations,
  total_input_tokens,
  total_output_tokens,
  total_cache_read_tokens,
  cache_hit_rate_pct,
  total_cost_usd,
  cost_per_1k_tokens
FROM metrics.v_weekly_efficiency
ORDER BY period_start DESC, total_cost_usd DESC;

COMMENT ON VIEW metrics.v_combined_metrics IS
  'Combined daily + weekly metrics. P191 AC-5: period column with daily/weekly values.';

-- ── v_agent_performance ─────────────────────────────────────────────────────
-- AC-6: efficiency_rank + lifetime_cache_hit_pct columns

CREATE VIEW metrics.v_agent_performance AS
SELECT
  agent_role                                              AS agent_identity,
  model                                                   AS model_name,
  agent_role,
  model,
  sum(invocations)                                        AS total_invocations,
  sum(total_input_tokens)                                 AS lifetime_input_tokens,
  sum(total_output_tokens)                                AS lifetime_output_tokens,
  sum(total_cache_read_tokens)                            AS lifetime_cache_read_tokens,
  -- AC-6: lifetime_cache_hit_pct
  CASE WHEN sum(total_input_tokens + total_cache_read_tokens) > 0
    THEN round(
      100.0 * sum(total_cache_read_tokens)::numeric
      / sum(total_input_tokens + total_cache_read_tokens)::numeric,
      1
    )
    ELSE 0.0
  END                                                     AS lifetime_cache_hit_pct,
  -- legacy column
  round(avg(avg_cache_hit_rate), 3)                       AS overall_cache_hit_rate,
  sum(total_cost_usd)                                     AS lifetime_cost_usd,
  round(sum(total_cost_usd) / NULLIF(sum(invocations), 0), 6) AS cost_per_invocation,
  round(
    (sum(total_input_tokens) + sum(total_output_tokens))
    / NULLIF(sum(total_cost_usd), 0),
    0
  )                                                       AS tokens_per_dollar,
  -- AC-6: efficiency_rank (ranked by lifetime_cost_usd DESC)
  ROW_NUMBER() OVER (ORDER BY sum(total_cost_usd) DESC)  AS efficiency_rank
FROM metrics.v_daily_efficiency
GROUP BY agent_role, model
ORDER BY lifetime_cost_usd DESC;

COMMENT ON VIEW metrics.v_agent_performance IS
  'Lifetime agent performance. P191 AC-6: adds efficiency_rank and lifetime_cache_hit_pct.';

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT ON metrics.v_daily_efficiency   TO roadmap_agent;
GRANT SELECT ON metrics.v_weekly_efficiency  TO roadmap_agent;
GRANT SELECT ON metrics.v_combined_metrics   TO roadmap_agent;
GRANT SELECT ON metrics.v_agent_performance  TO roadmap_agent;

COMMIT;
