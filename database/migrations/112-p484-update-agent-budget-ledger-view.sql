-- P484: Update roadmap.agent_budget_ledger view to expose project_id
--
-- Migration 111 added project_id to roadmap_efficiency.agent_budget_ledger.
-- The roadmap schema view must be updated to expose it so allowlist-check.ts
-- can filter by project_id in checkBudgetAtomic().

CREATE OR REPLACE VIEW roadmap.agent_budget_ledger AS
  SELECT id,
         proposal_id,
         agent_run_id,
         agent_identity,
         model_used,
         tokens_in,
         tokens_out,
         cost_usd,
         budget_allocated_usd,
         budget_remaining_usd,
         cumulative_cost_usd,
         recorded_at,
         project_id
    FROM agent_budget_ledger;
