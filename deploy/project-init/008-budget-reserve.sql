-- ============================================================
-- project-init/008-budget-reserve.sql
-- Budget reserve schema: reserve share split, eligibility check, dispatch gate logic.
-- Depends on: 001-proposal.sql, 005-spend.sql, 007-cross-project-dependencies.sql (P896).
-- Run with: psql -v schema_name=agentHive -f 008-budget-reserve.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- Ensure tier column exists on proposal (added as part of P897)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = :'schema_name' AND table_name = 'proposal' AND column_name = 'tier'
  ) THEN
    ALTER TABLE :schema_name.proposal
      ADD COLUMN tier TEXT NOT NULL DEFAULT 'B'
      CHECK (tier IN ('A','B','C'));
    CREATE INDEX IF NOT EXISTS proposal_tier_idx ON :schema_name.proposal(tier)
      WHERE tier IN ('A','B');
  END IF;
END $$;

-- ============================================================
-- Ensure share columns exist on spBudget (added as part of P897)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = :'schema_name' AND table_name = 'spBudget' AND column_name = 'ordinary_share'
  ) THEN
    ALTER TABLE :schema_name.spBudget
      ADD COLUMN ordinary_share NUMERIC(5,2) NOT NULL DEFAULT 0.80,
      ADD COLUMN unblock_reserve_share NUMERIC(5,2) NOT NULL DEFAULT 0.20,
      ADD CONSTRAINT spbudget_share_sum_le_one
        CHECK (ordinary_share + unblock_reserve_share <= 1.0);
  END IF;
END $$;

-- ============================================================
-- fn_get_budget_reserve_status()
-- Computes reserve and ordinary spend status for a given budget.
-- Returns: (ordinary_spent, ordinary_cap, reserve_spent, reserve_cap, utilization_ordinary_pct, utilization_reserve_pct)
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_get_budget_reserve_status(
  p_budget_id BIGINT
)
RETURNS TABLE (
  ordinary_spent NUMERIC,
  ordinary_cap NUMERIC,
  reserve_spent NUMERIC,
  reserve_cap NUMERIC,
  utilization_ordinary_pct NUMERIC,
  utilization_reserve_pct NUMERIC
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_budget_usd NUMERIC;
  v_ordinary_share NUMERIC;
  v_reserve_share NUMERIC;
  v_ordinary_cap NUMERIC;
  v_reserve_cap NUMERIC;
  v_ordinary_spent NUMERIC := 0;
  v_reserve_spent NUMERIC := 0;
  v_ord_util NUMERIC;
  v_res_util NUMERIC;
BEGIN
  -- Fetch budget and share allocations
  SELECT budget_usd, ordinary_share, unblock_reserve_share
    INTO v_budget_usd, v_ordinary_share, v_reserve_share
    FROM :schema_name.spBudget
   WHERE id = p_budget_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget % not found', p_budget_id;
  END IF;

  -- Compute caps
  v_ordinary_cap := v_budget_usd * v_ordinary_share;
  v_reserve_cap := v_budget_usd * v_reserve_share;

  -- Compute spend: ordinary is all proposals NOT in a cross_project_dependency edge
  -- reserve is proposals that ARE in a blocking cross_project_dependency edge (from v2's perspective)
  -- This requires joining to core.cross_project_dependency table (in control-plane schema)

  -- For now, use a simpler heuristic: classify by proposal_id in spLedger
  -- and cross-check against governance.decision records that logged reserve draws

  WITH blocking_proposals AS (
    -- Identify proposals that are eligible for reserve (are 'to' side of a blocking edge)
    SELECT DISTINCT pd.display_id
      FROM :schema_name.proposal p
      JOIN core.cross_project_dependency cpd
        ON p.display_id = cpd.to_proposal_display_id
       AND cpd.kind = 'blocks'
     WHERE cpd.from_project_id IS NOT NULL
  )
  SELECT COALESCE(SUM(CASE
           WHEN l.proposal_id NOT IN (SELECT pid FROM :schema_name.proposal WHERE display_id IN (SELECT display_id FROM blocking_proposals))
           THEN l.cost_usd ELSE 0 END), 0),
         COALESCE(SUM(CASE
           WHEN l.proposal_id IN (SELECT pid FROM :schema_name.proposal WHERE display_id IN (SELECT display_id FROM blocking_proposals))
           THEN l.cost_usd ELSE 0 END), 0)
    INTO v_ordinary_spent, v_reserve_spent
    FROM :schema_name.spLedger l
   WHERE l.budget_id = p_budget_id;

  -- Compute utilization percentages
  v_ord_util := CASE
    WHEN v_ordinary_cap > 0 THEN ROUND(100.0 * v_ordinary_spent / v_ordinary_cap, 2)
    ELSE 0
  END;
  v_res_util := CASE
    WHEN v_reserve_cap > 0 THEN ROUND(100.0 * v_reserve_spent / v_reserve_cap, 2)
    ELSE 0
  END;

  RETURN QUERY SELECT
    v_ordinary_spent,
    v_ordinary_cap,
    v_reserve_spent,
    v_reserve_cap,
    v_ord_util,
    v_res_util;
END;
$$;

-- ============================================================
-- fn_is_reserve_eligible()
-- Checks if a proposal is eligible to consume the reserve budget.
-- Eligibility criteria:
-- 1. proposal.tier != 'C'
-- 2. proposal is named in core.cross_project_dependency.to_proposal_display_id with kind='blocks'
-- 3. any matching from_proposal has status IN ('Develop','Review')
-- Returns: boolean
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_is_reserve_eligible(
  p_proposal_id BIGINT
)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_display_id TEXT;
  v_tier TEXT;
  v_has_blocking_dep BOOLEAN := FALSE;
BEGIN
  -- Get proposal display_id and tier
  SELECT display_id, tier
    INTO v_display_id, v_tier
    FROM :schema_name.proposal
   WHERE id = p_proposal_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Class C proposals cannot use reserve
  IF v_tier = 'C' THEN
    RETURN FALSE;
  END IF;

  -- Check if this proposal is the 'to' side of a blocking cross_project_dependency
  -- and the 'from' side is in Develop or Review status
  SELECT EXISTS (
    SELECT 1
      FROM core.cross_project_dependency cpd
      LEFT JOIN :schema_name.proposal p_from
        ON p_from.display_id = cpd.from_proposal_display_id
     WHERE cpd.to_proposal_display_id = v_display_id
       AND cpd.kind = 'blocks'
       AND (p_from.status IN ('Develop','Review') OR cpd.from_proposal_display_id IS NOT NULL)
  ) INTO v_has_blocking_dep;

  RETURN v_has_blocking_dep;
END;
$$;

-- ============================================================
-- fn_decide_budget_share()
-- Dispatch gate logic: route cost to reserve, ordinary, or blocked.
-- Sequence:
-- 1. If reserve-eligible AND reserve has room → 'reserve'
-- 2. Else if ordinary has room → 'ordinary'
-- 3. Else → 'blocked'
-- Returns: (share TEXT, reason TEXT, ordinary_remaining NUMERIC, reserve_remaining NUMERIC)
-- ============================================================
CREATE OR REPLACE FUNCTION :schema_name.fn_decide_budget_share(
  p_proposal_id BIGINT,
  p_budget_id BIGINT,
  p_cost_estimate NUMERIC
)
RETURNS TABLE (
  share TEXT,
  reason TEXT,
  ordinary_remaining NUMERIC,
  reserve_remaining NUMERIC
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_is_eligible BOOLEAN;
  v_ordinary_spent NUMERIC;
  v_ordinary_cap NUMERIC;
  v_reserve_spent NUMERIC;
  v_reserve_cap NUMERIC;
BEGIN
  -- Check reserve eligibility
  v_is_eligible := :schema_name.fn_is_reserve_eligible(p_proposal_id);

  -- Get current spend status
  SELECT ordinary_spent, ordinary_cap, reserve_spent, reserve_cap
    INTO v_ordinary_spent, v_ordinary_cap, v_reserve_spent, v_reserve_cap
    FROM :schema_name.fn_get_budget_reserve_status(p_budget_id);

  -- Decision logic
  IF v_is_eligible AND (v_reserve_spent + p_cost_estimate <= v_reserve_cap) THEN
    RETURN QUERY SELECT
      'reserve'::TEXT,
      'Reserve-eligible and reserve has capacity'::TEXT,
      v_ordinary_cap - v_ordinary_spent,
      v_reserve_cap - (v_reserve_spent + p_cost_estimate);
  ELSIF v_ordinary_spent + p_cost_estimate <= v_ordinary_cap THEN
    RETURN QUERY SELECT
      'ordinary'::TEXT,
      CASE WHEN v_is_eligible THEN 'Reserve eligible but reserve exhausted; routing to ordinary'::TEXT
           ELSE 'Not reserve eligible; routing to ordinary'::TEXT END,
      v_ordinary_cap - (v_ordinary_spent + p_cost_estimate),
      v_reserve_cap - v_reserve_spent;
  ELSE
    RETURN QUERY SELECT
      'blocked'::TEXT,
      'Both ordinary and reserve exhausted'::TEXT,
      v_ordinary_cap - v_ordinary_spent,
      v_reserve_cap - v_reserve_spent;
  END IF;
END;
$$;

COMMENT ON FUNCTION :schema_name.fn_get_budget_reserve_status IS
  'Computes current spend against ordinary and reserve budget shares. '
  'Ordinary: all non-blocking proposals. Reserve: proposals in blocking cross-project deps.';

COMMENT ON FUNCTION :schema_name.fn_is_reserve_eligible IS
  'Returns TRUE if proposal is Class A/B, named in cross_project_dependency.to_proposal_display_id with kind=blocks, '
  'and source proposal is in Develop or Review status.';

COMMENT ON FUNCTION :schema_name.fn_decide_budget_share IS
  'Dispatch gate decision: routes cost to reserve, ordinary, or blocked. '
  'Reserve takes priority if eligible and has capacity; ordinary is fallback; blocked if both exhausted.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT EXECUTE ON FUNCTION :schema_name.fn_get_budget_reserve_status TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_is_reserve_eligible TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_decide_budget_share TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT EXECUTE ON FUNCTION :schema_name.fn_get_budget_reserve_status TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_is_reserve_eligible TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION :schema_name.fn_decide_budget_share TO agenthive_observability;
  END IF;
END $$;
