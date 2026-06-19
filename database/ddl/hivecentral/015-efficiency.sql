-- ============================================================
-- 015-efficiency: Cost attribution, dispatch metrics, and token
-- budget tracking for hiveCentral.
-- Written by the stats collector on the slow path; never on the
-- hot dispatch path except route_token_budget.
-- ============================================================
-- owner_did exempt (AC-1, whole schema): every table here is a metric/counter
-- stream, not a managed catalog entity, so per-row ownership/lifecycle hygiene does
-- not apply. efficiency_metric, cost_ledger_summary, dispatch_metric_summary are
-- append-only, monthly-partitioned rollups (REVOKE UPDATE,DELETE + deny-mutation
-- trigger each). route_token_budget is a high-frequency anonymous counter mutated on
-- the hot dispatch path with lazy-reset windows (same rationale as the
-- core.service_heartbeat carve-out — adding hygiene columns would waste hot-path I/O).
-- Provenance is carried in-row via project_id / route_id / agency_id.
-- Target DB:  hiveCentral
-- Owner:      agenthive_admin
-- Roles:      agenthive_orchestrator (rw route_token_budget, r all),
--             agenthive_agency (r all, w efficiency_metric/cost_ledger_summary/dispatch_metric_summary/route_token_budget),
--             agenthive_observability (r all)
-- Min PG:     16
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS efficiency;

COMMENT ON SCHEMA efficiency IS
  'Cost attribution and performance efficiency metrics. Append-only summary tables are '
  'written by background stats collectors. route_token_budget is the exception: it is '
  'written on the hot dispatch path for token window tracking (P747 D4).';

-- ============================================================
-- efficiency.efficiency_metric — general purpose metric store (append-only, 2y)
-- ============================================================
CREATE TABLE IF NOT EXISTS efficiency.efficiency_metric (
  id           BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id   BIGINT       NOT NULL,
  agency_id    BIGINT,
  metric_kind  TEXT         NOT NULL,
  value        NUMERIC(14,4) NOT NULL,
  measured_at  TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS efficiency_metric_project_kind_measured
  ON efficiency.efficiency_metric (project_id, metric_kind, measured_at DESC);
CREATE INDEX IF NOT EXISTS efficiency_metric_agency_created
  ON efficiency.efficiency_metric (agency_id, created_at DESC);

REVOKE UPDATE, DELETE ON efficiency.efficiency_metric FROM PUBLIC;

CREATE OR REPLACE FUNCTION efficiency.deny_efficiency_metric_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'efficiency.efficiency_metric is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER efficiency_metric_no_update
  BEFORE UPDATE ON efficiency.efficiency_metric
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_efficiency_metric_mutation();

CREATE OR REPLACE TRIGGER efficiency_metric_no_delete
  BEFORE DELETE ON efficiency.efficiency_metric
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_efficiency_metric_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'efficiency.efficiency_metric',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '2 years', retention_keep_table = false
  WHERE parent_table = 'efficiency.efficiency_metric';

COMMENT ON TABLE efficiency.efficiency_metric IS
  'General-purpose efficiency metric store. metric_kind is a free-form string '
  '(e.g. dispatch_latency_p99_ms, tokens_per_proposal, cost_per_dispatch_usd). '
  'Partitioned monthly; 2-year retention.';

-- ============================================================
-- efficiency.cost_ledger_summary — period cost rollups (append-only, monthly partition)
-- ============================================================
CREATE TABLE IF NOT EXISTS efficiency.cost_ledger_summary (
  id            BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id    BIGINT       NOT NULL,
  route_id      BIGINT
                REFERENCES control_model.model_route (id) ON DELETE SET NULL,
  period_start  TIMESTAMPTZ  NOT NULL,
  period_end    TIMESTAMPTZ  NOT NULL,
  total_usd     NUMERIC(14,4) NOT NULL,
  total_tokens  BIGINT       NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS cost_ledger_summary_project_period
  ON efficiency.cost_ledger_summary (project_id, period_start DESC);
CREATE INDEX IF NOT EXISTS cost_ledger_summary_route_period
  ON efficiency.cost_ledger_summary (route_id, period_start DESC);

REVOKE UPDATE, DELETE ON efficiency.cost_ledger_summary FROM PUBLIC;

CREATE OR REPLACE FUNCTION efficiency.deny_cost_ledger_summary_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'efficiency.cost_ledger_summary is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER cost_ledger_summary_no_update
  BEFORE UPDATE ON efficiency.cost_ledger_summary
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_cost_ledger_summary_mutation();

CREATE OR REPLACE TRIGGER cost_ledger_summary_no_delete
  BEFORE DELETE ON efficiency.cost_ledger_summary
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_cost_ledger_summary_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'efficiency.cost_ledger_summary',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
-- No retention limit: ledger summaries are kept for finance auditing

COMMENT ON TABLE efficiency.cost_ledger_summary IS
  'Pre-aggregated cost ledger summaries per project per route per period. '
  'The background stats collector writes these; never the hot path. '
  'Partitioned monthly; no pruning (retained for finance audit).';

-- ============================================================
-- efficiency.dispatch_metric_summary — dispatch performance rollups (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS efficiency.dispatch_metric_summary (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id      BIGINT       NOT NULL,
  template_id     BIGINT
                  REFERENCES template.workflow_template (id) ON DELETE SET NULL,
  stage           TEXT         NOT NULL,
  maturity        TEXT         NOT NULL,
  period_start    TIMESTAMPTZ  NOT NULL,
  dispatched_count INT         NOT NULL,
  avg_latency_ms  INT,
  success_rate    NUMERIC(5,4),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS dispatch_metric_summary_project_stage_period
  ON efficiency.dispatch_metric_summary (project_id, stage, period_start DESC);

REVOKE UPDATE, DELETE ON efficiency.dispatch_metric_summary FROM PUBLIC;

CREATE OR REPLACE FUNCTION efficiency.deny_dispatch_metric_summary_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'efficiency.dispatch_metric_summary is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER dispatch_metric_summary_no_update
  BEFORE UPDATE ON efficiency.dispatch_metric_summary
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_dispatch_metric_summary_mutation();

CREATE OR REPLACE TRIGGER dispatch_metric_summary_no_delete
  BEFORE DELETE ON efficiency.dispatch_metric_summary
  FOR EACH ROW EXECUTE FUNCTION efficiency.deny_dispatch_metric_summary_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'efficiency.dispatch_metric_summary',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '2 years', retention_keep_table = false
  WHERE parent_table = 'efficiency.dispatch_metric_summary';

COMMENT ON TABLE efficiency.dispatch_metric_summary IS
  'Pre-aggregated dispatch performance rollups per (project, template, stage, maturity, period). '
  'Used by dashboards and the capacity planner. Partitioned monthly; 2-year retention.';

-- ============================================================
-- efficiency.route_token_budget — live token window tracking (P747 D4)
-- NOT append-only: the route picker UPDATEs this on the hot dispatch path.
-- Lazy reset: when window_start + window_hours * interval is in the past,
-- the application (resolve_route) does:
--   UPDATE SET tokens_used=0, window_start=now(), updated_at=clock_timestamp()
-- This avoids a cron dependency on the critical path.
-- ============================================================
CREATE TABLE IF NOT EXISTS efficiency.route_token_budget (
  id            BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    BIGINT       NOT NULL,
  route_id      BIGINT       NOT NULL
                             REFERENCES control_model.model_route (id) ON DELETE CASCADE,
  window_start  TIMESTAMPTZ  NOT NULL,
  window_hours  INT          NOT NULL DEFAULT 1,
  tokens_used   BIGINT       NOT NULL DEFAULT 0,
  tokens_cap    BIGINT       NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (project_id, route_id, window_start)
);

CREATE INDEX IF NOT EXISTS route_token_budget_project_route_window
  ON efficiency.route_token_budget (project_id, route_id, window_start DESC);

COMMENT ON TABLE efficiency.route_token_budget IS
  'Live hourly token budget tracker per (project, route) (P747 D4). '
  'The route picker reads + updates this on the hot path. Lazy reset: when '
  'window_start + window_hours * interval < now(), the picker resets tokens_used=0 '
  'and advances window_start rather than relying on a cron job. '
  'UNIQUE (project_id, route_id, window_start) allows concurrent pickers to upsert.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA efficiency TO agenthive_orchestrator;
    GRANT SELECT ON ALL TABLES IN SCHEMA efficiency TO agenthive_orchestrator;
    GRANT INSERT, UPDATE ON efficiency.route_token_budget TO agenthive_orchestrator;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA efficiency TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA efficiency TO agenthive_agency;
    GRANT SELECT ON ALL TABLES IN SCHEMA efficiency TO agenthive_agency;
    GRANT INSERT ON efficiency.efficiency_metric         TO agenthive_agency;
    GRANT INSERT ON efficiency.cost_ledger_summary       TO agenthive_agency;
    GRANT INSERT ON efficiency.dispatch_metric_summary   TO agenthive_agency;
    GRANT INSERT, UPDATE ON efficiency.route_token_budget TO agenthive_agency;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA efficiency TO agenthive_agency;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA efficiency TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA efficiency TO agenthive_observability;
  END IF;
END $$;

\echo 'efficiency schema applied.'
