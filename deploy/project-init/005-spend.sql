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
  ordinary_share   NUMERIC(5,2)  NOT NULL DEFAULT 0.80,   -- fraction for ordinary dispatches
  unblock_reserve_share NUMERIC(5,2) NOT NULL DEFAULT 0.20, -- fraction reserved for cross-project unblocks
  metadata_jsonb   JSONB         NOT NULL DEFAULT '{}',
  lifecycle_status TEXT          NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT spbudget_share_sum_le_one
    CHECK (ordinary_share + unblock_reserve_share <= 1.0)
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

-- ============================================================
-- Idempotent ALTER for existing deployments (P897)
-- Adds ordinary_share / unblock_reserve_share if the table
-- was created before this migration was applied.
-- ============================================================
DO $$
BEGIN
  ALTER TABLE :schema_name.sp_budget
    ADD COLUMN IF NOT EXISTS ordinary_share NUMERIC(5,2) NOT NULL DEFAULT 0.80;
  ALTER TABLE :schema_name.sp_budget
    ADD COLUMN IF NOT EXISTS unblock_reserve_share NUMERIC(5,2) NOT NULL DEFAULT 0.20;
  ALTER TABLE :schema_name.sp_budget
    DROP CONSTRAINT IF EXISTS spbudget_share_sum_le_one;
  ALTER TABLE :schema_name.sp_budget
    ADD CONSTRAINT spbudget_share_sum_le_one
      CHECK (ordinary_share + unblock_reserve_share <= 1.0);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ============================================================
-- fn_is_reserve_eligible(p_proposal_id BIGINT) → BOOLEAN  (P897)
-- Returns TRUE if the proposal is targeted by an active
-- 'blocks' cross-project dependency whose from-side proposal
-- is still in Develop or Review, AND the proposal tier != 'C'.
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_is_reserve_eligible(p_proposal_id BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE
SET search_path = :schema_name
AS $$
DECLARE
  v_display_id  TEXT;
  v_tier        TEXT;
  v_edge        RECORD;
  v_schema      TEXT;
  v_status      TEXT;
BEGIN
  SELECT display_id, tier INTO v_display_id, v_tier
  FROM proposal WHERE id = p_proposal_id;

  IF NOT FOUND OR v_tier = 'C' THEN RETURN FALSE; END IF;

  FOR v_edge IN
    SELECT cpd.edge_id, p.schema_name AS proj_schema, cpd.from_proposal_display_id
    FROM core.cross_project_dependency cpd
    JOIN core.project p ON cpd.from_project_id = p.id
    WHERE cpd.to_proposal_display_id = v_display_id AND cpd.kind = 'blocks'
  LOOP
    BEGIN
      EXECUTE format('SELECT status FROM %I.proposal WHERE display_id = %L',
        v_edge.proj_schema, v_edge.from_proposal_display_id)
      INTO v_status;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
    IF v_status IN ('Develop', 'Review') THEN
      RETURN TRUE;
    END IF;
  END LOOP;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION :schema_name.fn_is_reserve_eligible(BIGINT) IS
  'Returns TRUE when a proposal is the target of an active blocks cross-project dependency '
  'whose from-side is in Develop/Review and the proposal tier is not C.';

-- ============================================================
-- fn_get_budget_reserve_status(p_budget_id BIGINT)         (P897)
-- Classifies each spLedger entry as ordinary or reserve spend
-- and returns per-share caps and actuals for the budget.
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_get_budget_reserve_status(p_budget_id BIGINT)
RETURNS TABLE (
  budget_usd            NUMERIC(14,6),
  ordinary_share        NUMERIC(5,2),
  ordinary_cap          NUMERIC(14,6),
  ordinary_spent        NUMERIC(14,6),
  reserve_share         NUMERIC(5,2),
  reserve_cap           NUMERIC(14,6),
  reserve_spent         NUMERIC(14,6)
) LANGUAGE plpgsql STABLE
SET search_path = :schema_name
AS $$
DECLARE
  v_budget   RECORD;
  v_row      RECORD;
  v_ord      NUMERIC(14,6) := 0;
  v_res      NUMERIC(14,6) := 0;
BEGIN
  SELECT bgt.budget_usd, bgt.ordinary_share, bgt.unblock_reserve_share
  INTO v_budget
  FROM sp_budget bgt WHERE bgt.id = p_budget_id;

  IF NOT FOUND THEN RETURN; END IF;

  FOR v_row IN
    SELECT l.cost_usd, l.proposal_id
    FROM sp_ledger l WHERE l.budget_id = p_budget_id
  LOOP
    IF v_row.proposal_id IS NOT NULL AND fn_is_reserve_eligible(v_row.proposal_id) THEN
      v_res := v_res + v_row.cost_usd;
    ELSE
      v_ord := v_ord + v_row.cost_usd;
    END IF;
  END LOOP;

  RETURN QUERY SELECT
    v_budget.budget_usd,
    v_budget.ordinary_share,
    (v_budget.budget_usd * v_budget.ordinary_share)::NUMERIC(14,6),
    v_ord,
    v_budget.unblock_reserve_share,
    (v_budget.budget_usd * v_budget.unblock_reserve_share)::NUMERIC(14,6),
    v_res;
END;
$$;

COMMENT ON FUNCTION :schema_name.fn_get_budget_reserve_status(BIGINT) IS
  'Returns ordinary and reserve share caps and actuals for a given budget_id. '
  'Classifies ledger entries via fn_is_reserve_eligible.';

-- ============================================================
-- fn_decide_budget_share(proposal_id, budget_id, cost)      (P897)
-- Returns ''reserve'', ''ordinary'', or ''blocked''.
-- Logs reserve draws to governance.decision and emits
-- depletion alarms to governance.event.
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_decide_budget_share(
  p_proposal_id   BIGINT,
  p_budget_id     BIGINT,
  p_cost_estimate NUMERIC(14,6)
) RETURNS TEXT LANGUAGE plpgsql VOLATILE
SET search_path = :schema_name
AS $$
DECLARE
  v_status    RECORD;
  v_eligible  BOOLEAN;
  v_display   TEXT;
  v_pstatus   TEXT;
  v_edge_id   BIGINT;
  v_ratio     NUMERIC;
BEGIN
  SELECT * INTO v_status FROM fn_get_budget_reserve_status(p_budget_id);
  IF NOT FOUND THEN RETURN 'blocked'; END IF;

  v_eligible := fn_is_reserve_eligible(p_proposal_id);

  SELECT p.display_id, p.status INTO v_display, v_pstatus
  FROM proposal p WHERE p.id = p_proposal_id;

  IF v_eligible THEN
    SELECT MIN(cpd.edge_id) INTO v_edge_id
    FROM core.cross_project_dependency cpd
    WHERE cpd.to_proposal_display_id = v_display AND cpd.kind = 'blocks';
  END IF;

  IF v_eligible AND (v_status.reserve_spent + p_cost_estimate) <= v_status.reserve_cap THEN
    INSERT INTO governance.decision
      (proposal_ref, stage, outcome, actor_did, rationale, metadata_jsonb)
    VALUES (
      v_display,
      COALESCE(v_pstatus, 'unknown'),
      'advance',
      'system',
      'Budget reserve allocation for cross-project unblock',
      jsonb_build_object(
        'kind', 'unblock_reserve_draw',
        'decision_type', 'budget_reserve_draw',
        'cost_usd', p_cost_estimate,
        'budget_id', p_budget_id,
        'cross_project_dependency_edge_id', v_edge_id
      )
    );

    -- Depletion alarm
    v_ratio := (v_status.reserve_spent + p_cost_estimate) / NULLIF(v_status.reserve_cap, 0);
    IF v_ratio >= 1.0 THEN
      INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
      VALUES ('unblock_reserve_critical', 'system', 'budget:' || p_budget_id,
        jsonb_build_object('budget_id', p_budget_id,
          'spent', v_status.reserve_spent + p_cost_estimate,
          'cap', v_status.reserve_cap, 'ratio', v_ratio));
    ELSIF v_ratio >= 0.80 THEN
      INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
      VALUES ('unblock_reserve_warning', 'system', 'budget:' || p_budget_id,
        jsonb_build_object('budget_id', p_budget_id,
          'spent', v_status.reserve_spent + p_cost_estimate,
          'cap', v_status.reserve_cap, 'ratio', v_ratio));
    END IF;

    RETURN 'reserve';
  END IF;

  IF (v_status.ordinary_spent + p_cost_estimate) <= v_status.ordinary_cap THEN
    RETURN 'ordinary';
  END IF;

  RETURN 'blocked';
END;
$$;

COMMENT ON FUNCTION :schema_name.fn_decide_budget_share(BIGINT, BIGINT, NUMERIC) IS
  'Routes a dispatch to reserve, ordinary, or blocked. Reserve draws are logged to '
  'governance.decision; depletion alarms emitted to governance.event at 80% and 100%.';

-- ============================================================
-- Grants for P897 functions
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT EXECUTE ON FUNCTION :schema_name.fn_is_reserve_eligible(BIGINT) TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_get_budget_reserve_status(BIGINT) TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_decide_budget_share(BIGINT, BIGINT, NUMERIC) TO agenthive_orchestrator;
  END IF;
END $$;
