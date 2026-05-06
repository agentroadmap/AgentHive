-- ============================================================
-- project-init/005-spend.sql
-- Spending and budget tracking: sp_budget, sp_ledger, sp_route.
-- Run with: psql -v schema_name=agentHive -f 005-spend.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- sp_budget — per-proposal (or project-wide) token/cost budgets
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.sp_budget (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       REFERENCES :schema_name.proposal (id) ON DELETE SET NULL,
  scope            TEXT         NOT NULL DEFAULT 'proposal'
                               CHECK (scope IN ('project','proposal','agent')),
  scope_ref        TEXT,                                  -- proposal display_id or agent slug for quick lookup
  budget_usd       NUMERIC(14,6) NOT NULL,
  budget_tokens    BIGINT,
  period_start     TIMESTAMPTZ,
  period_end       TIMESTAMPTZ,
  alert_threshold  NUMERIC(5,2)  NOT NULL DEFAULT 0.80,   -- fraction of budget at which to alert
  metadata_jsonb   JSONB         NOT NULL DEFAULT '{}',
  lifecycle_status TEXT          NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spbudget_proposal ON :schema_name.sp_budget (proposal_id)
  WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS spbudget_scope ON :schema_name.sp_budget (scope, scope_ref)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_spbudget
  BEFORE UPDATE ON :schema_name.sp_budget
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.sp_budget IS
  'Token and cost budgets scoped to project, proposal, or agent.';

-- ============================================================
-- sp_ledger — spend events (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.sp_ledger (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_id        BIGINT       REFERENCES :schema_name.sp_budget (id) ON DELETE SET NULL,
  proposal_id      BIGINT       REFERENCES :schema_name.proposal (id) ON DELETE SET NULL,
  agent_slug       TEXT         NOT NULL,
  model_id         TEXT,                                  -- soft FK to agency.model.model_id
  input_tokens     INT          NOT NULL DEFAULT 0,
  output_tokens    INT          NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  session_ref      TEXT,                                  -- agency session id or correlation id
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spledger_proposal ON :schema_name.sp_ledger (proposal_id);
CREATE INDEX IF NOT EXISTS spledger_agent ON :schema_name.sp_ledger (agent_slug);
CREATE INDEX IF NOT EXISTS spledger_recorded_at ON :schema_name.sp_ledger (recorded_at);

COMMENT ON TABLE :schema_name.sp_ledger IS
  'Append-only spend ledger. Each token consumption event produces one row.';

-- ============================================================
-- sp_route — cost rollup per model route (summary table)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.sp_route (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id         TEXT         NOT NULL,
  period_date      DATE         NOT NULL,                 -- daily rollup
  total_input_tokens  BIGINT    NOT NULL DEFAULT 0,
  total_output_tokens BIGINT    NOT NULL DEFAULT 0,
  total_cost_usd   NUMERIC(14,6) NOT NULL DEFAULT 0,
  rollup_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (model_id, period_date)
);

CREATE INDEX IF NOT EXISTS sproute_period ON :schema_name.sp_route (period_date);

COMMENT ON TABLE :schema_name.sp_route IS
  'Daily cost rollup per model route. Populated by background job from sp_ledger.';
