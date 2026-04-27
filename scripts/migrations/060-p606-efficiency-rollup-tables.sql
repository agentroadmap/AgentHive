-- Migration 060: P606 — Centralized Efficiency Rollup Tables
--
-- Adds:
--   1. roadmap.model_routes.tier TEXT — model capability tier used by Block 1
--      aggregation to segment cost_ledger_summary by frontier/mid/lower/tool.
--   2. roadmap_efficiency schema + three central rollup tables:
--        efficiency_metric      (EAV, per project/agency/day)
--        cost_ledger_summary    (per project/agency/hour/model_tier)
--        dispatch_metric_summary (per project/agency/hour/dispatch_status)
--   3. Wrapper views over rollup tables replacing raw-scan views:
--        roadmap.v_daily_spend        (DROP+CREATE — column 1 renamed)
--        metrics.v_daily_efficiency   (DROP CASCADE+CREATE — column 2 renamed;
--                                      CASCADE drops v_combined_metrics, v_agent_performance)
--        metrics.v_combined_metrics   (explicit CREATE OR REPLACE after CASCADE)
--        metrics.v_agent_performance  (explicit CREATE OR REPLACE after CASCADE)
--
-- Migration 061 (deferred): drop the wrapper views once all consumers query rollup tables directly.

BEGIN;

-- ── 0. PG 15 guard (NULLS NOT DISTINCT) ──────────────────────────────────────

DO $$ BEGIN
  IF (SELECT current_setting('server_version_num')::int < 150000) THEN
    RAISE EXCEPTION 'PG 15+ required: UNIQUE NULLS NOT DISTINCT not supported on PG %',
      current_setting('server_version');
  END IF;
END $$;

-- ── 1. Add tier column to roadmap.model_routes ───────────────────────────────
--
-- tier classifies the model by capability level for cost-segment reporting.
-- Values: frontier | mid | lower | tool | unknown (NULL treated as unknown at query time).

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS tier TEXT;

-- Backfill: classify existing routes by model_name pattern.
UPDATE roadmap.model_routes SET tier =
  CASE
    WHEN model_name ~* 'opus|^o3$|gpt-5'
      THEN 'frontier'
    WHEN model_name ~* 'sonnet|^gpt-4\.1$|^o4-mini$|^gpt-4o$'
      THEN 'mid'
    WHEN model_name ~* 'haiku|gpt-4\.1-mini|gpt-4\.1-nano|codex-mini|mimo-v2-(pro|omni|code|omni-lite)$'
      THEN 'lower'
    WHEN model_name ~* 'tts'
      THEN 'tool'
    ELSE 'unknown'
  END
WHERE tier IS NULL;

COMMENT ON COLUMN roadmap.model_routes.tier IS
  'Model capability tier for cost segmentation: frontier | mid | lower | tool | unknown';

-- ── 2. roadmap_efficiency schema ──────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS roadmap_efficiency;

-- ── 3. efficiency_metric — EAV, per project / agency / day ───────────────────
--
-- metric_name values: invocations, cache_hit_rate_pct, cost_usd, avg_run_ms, cache_savings_usd

CREATE TABLE IF NOT EXISTS roadmap_efficiency.efficiency_metric (
  id            BIGSERIAL    PRIMARY KEY,
  project_id    BIGINT       NOT NULL REFERENCES roadmap.project(project_id),
  agency_id     BIGINT       REFERENCES roadmap_workforce.agent_registry(id),
  date          DATE         NOT NULL,
  metric_name   TEXT         NOT NULL,
  value         NUMERIC      NOT NULL,
  sample_count  INT          NOT NULL DEFAULT 0,
  aggregated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (project_id, agency_id, date, metric_name)
);

CREATE INDEX IF NOT EXISTS efficiency_metric_project_date_idx
  ON roadmap_efficiency.efficiency_metric (project_id, date DESC);
CREATE INDEX IF NOT EXISTS efficiency_metric_agency_date_idx
  ON roadmap_efficiency.efficiency_metric (agency_id, date DESC)
  WHERE agency_id IS NOT NULL;

-- ── 4. cost_ledger_summary — per project / agency / hour / model_tier ─────────

CREATE TABLE IF NOT EXISTS roadmap_efficiency.cost_ledger_summary (
  id             BIGSERIAL    PRIMARY KEY,
  project_id     BIGINT       NOT NULL REFERENCES roadmap.project(project_id),
  agency_id      BIGINT       REFERENCES roadmap_workforce.agent_registry(id),
  hour           TIMESTAMPTZ  NOT NULL,
  model_tier     TEXT         NOT NULL DEFAULT 'unknown'
                 CHECK (model_tier IN ('frontier','mid','lower','tool','unknown')),
  total_cost_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
  event_count    INT           NOT NULL DEFAULT 0,
  total_tokens   BIGINT        NOT NULL DEFAULT 0,
  aggregated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (project_id, agency_id, hour, model_tier)
);

CREATE INDEX IF NOT EXISTS cost_ledger_summary_project_hour_idx
  ON roadmap_efficiency.cost_ledger_summary (project_id, hour DESC);
CREATE INDEX IF NOT EXISTS cost_ledger_summary_agency_hour_idx
  ON roadmap_efficiency.cost_ledger_summary (agency_id, hour DESC)
  WHERE agency_id IS NOT NULL;

-- ── 5. dispatch_metric_summary — per project / agency / hour / dispatch_status ─
--
-- Tracks five lifecycle states. 'open' and 'failed' (mig 038) are excluded
-- at the aggregation layer — they are pre-assignment / terminal-error states.

CREATE TABLE IF NOT EXISTS roadmap_efficiency.dispatch_metric_summary (
  id                BIGSERIAL    PRIMARY KEY,
  project_id        BIGINT       NOT NULL REFERENCES roadmap.project(project_id),
  agency_id         BIGINT       REFERENCES roadmap_workforce.agent_registry(id),
  hour              TIMESTAMPTZ  NOT NULL,
  dispatch_status   TEXT         NOT NULL
                    CHECK (dispatch_status IN ('assigned','active','completed','cancelled','blocked')),
  count             INT          NOT NULL DEFAULT 0,
  total_duration_ms BIGINT       NOT NULL DEFAULT 0,
  aggregated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (project_id, agency_id, hour, dispatch_status)
);

CREATE INDEX IF NOT EXISTS dispatch_metric_summary_project_hour_idx
  ON roadmap_efficiency.dispatch_metric_summary (project_id, hour DESC);

-- ── 6. Wrapper views ──────────────────────────────────────────────────────────
--
-- DROP+CREATE required (not CREATE OR REPLACE) because column names change:
--   v_daily_spend:      col 1 agent_identity → project_id
--   v_daily_efficiency: col 2 agent_role     → project_id
-- CASCADE on v_daily_efficiency drops v_combined_metrics + v_agent_performance;
-- both are explicitly recreated below.

DROP VIEW IF EXISTS roadmap.v_daily_spend;
CREATE VIEW roadmap.v_daily_spend AS
SELECT
  project_id,
  agency_id,
  date_trunc('day', hour)::DATE AS spend_date,
  SUM(total_cost_usd)           AS total_usd,
  SUM(event_count)              AS event_count
FROM roadmap_efficiency.cost_ledger_summary
GROUP BY project_id, agency_id, date_trunc('day', hour)::DATE;

DROP VIEW IF EXISTS metrics.v_daily_efficiency CASCADE;
CREATE VIEW metrics.v_daily_efficiency AS
SELECT
  date                  AS day,
  project_id,
  agency_id,
  MAX(CASE WHEN metric_name = 'invocations'        THEN value END)::BIGINT AS invocations,
  MAX(CASE WHEN metric_name = 'cache_hit_rate_pct' THEN value END)         AS cache_hit_rate_pct,
  MAX(CASE WHEN metric_name = 'cost_usd'           THEN value END)         AS total_cost_usd,
  MAX(CASE WHEN metric_name = 'avg_run_ms'         THEN value END)         AS avg_run_ms,
  MAX(CASE WHEN metric_name = 'cache_savings_usd'  THEN value END)         AS cache_savings_usd
FROM roadmap_efficiency.efficiency_metric
GROUP BY date, project_id, agency_id
ORDER BY day DESC;

CREATE OR REPLACE VIEW metrics.v_combined_metrics AS
SELECT
  d.day,
  d.project_id,
  d.agency_id,
  d.invocations,
  d.cache_hit_rate_pct,
  d.total_cost_usd,
  d.avg_run_ms,
  d.cache_savings_usd
FROM metrics.v_daily_efficiency d
ORDER BY d.day DESC, d.total_cost_usd DESC;

CREATE OR REPLACE VIEW metrics.v_agent_performance AS
SELECT
  project_id,
  agency_id,
  SUM(invocations)                                              AS total_invocations,
  ROUND(AVG(cache_hit_rate_pct), 3)                             AS overall_cache_hit_rate_pct,
  SUM(total_cost_usd)                                           AS lifetime_cost_usd,
  ROUND(SUM(total_cost_usd) / NULLIF(SUM(invocations), 0), 6)  AS cost_per_invocation,
  SUM(cache_savings_usd)                                        AS lifetime_cache_savings_usd
FROM metrics.v_daily_efficiency
GROUP BY 1, 2
ORDER BY lifetime_cost_usd DESC;

-- ── 7. Grants ─────────────────────────────────────────────────────────────────

GRANT USAGE  ON SCHEMA roadmap_efficiency TO roadmap_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_efficiency TO roadmap_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA roadmap_efficiency
  GRANT SELECT ON TABLES TO roadmap_agent;

-- ── 8. Warm the planner ───────────────────────────────────────────────────────

ANALYZE roadmap_efficiency.efficiency_metric;
ANALYZE roadmap_efficiency.cost_ledger_summary;
ANALYZE roadmap_efficiency.dispatch_metric_summary;

COMMIT;
