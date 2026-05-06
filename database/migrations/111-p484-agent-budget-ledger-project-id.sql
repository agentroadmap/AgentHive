-- P484 Phase 2: Add project_id to agent_budget_ledger for per-project budget tracking
--
-- The roadmap_efficiency.agent_budget_ledger table is exposed via a view in roadmap.
-- This migration adds the project_id column to enable per-project spend aggregation
-- in the budget enforcement logic (src/shared/dispatch/allowlist-check.ts).

ALTER TABLE roadmap_efficiency.agent_budget_ledger
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES roadmap.project(project_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_abl_project_recorded
  ON roadmap_efficiency.agent_budget_ledger(project_id, recorded_at DESC);
