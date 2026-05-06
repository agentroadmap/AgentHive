-- Migration 105: P842 — Hard Budget Enforcement schema
--
-- Phase 1: Creates roadmap.principal_spending_cap (per-principal spending caps)
-- and extends the existing roadmap.dispatch_route_audit with P842 budget columns.
-- Phase 3 enforcement (checkAgentBudget wired into callTool) is gated on P484 COMPLETE.

BEGIN;

-- ── 1. principal_spending_cap ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.principal_spending_cap (
  principal_id              TEXT        NOT NULL
    REFERENCES roadmap.principal_identity(principal_id) ON DELETE CASCADE,
  project_id                TEXT        NOT NULL,
  period                    TEXT        NOT NULL
    CHECK (period IN ('day', 'week', 'month', 'total')),
  max_usd_cents             BIGINT      NOT NULL,
  current_spent_usd_cents   BIGINT      NOT NULL DEFAULT 0,
  last_reset_at             TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_id, project_id, period)
);

CREATE INDEX IF NOT EXISTS idx_psc_principal_project
  ON roadmap.principal_spending_cap (principal_id, project_id);

COMMENT ON TABLE roadmap.principal_spending_cap IS
  'P842: Hard per-principal spending caps. Missing row = no cap (fail-open). Phase 3 enforcement gated on P484.';

-- ── 2. Extend dispatch_route_audit with P842 budget columns ───────────────────
-- The table already exists (pre-P842 migration). Add columns if absent.
ALTER TABLE roadmap.dispatch_route_audit
  ADD COLUMN IF NOT EXISTS budget_decision             TEXT
    CHECK (budget_decision IN ('approved', 'rejected') OR budget_decision IS NULL),
  ADD COLUMN IF NOT EXISTS budget_reject_reason        TEXT
    CHECK (budget_reject_reason IN ('project_cap', 'agent_cap') OR budget_reject_reason IS NULL),
  ADD COLUMN IF NOT EXISTS agent_budget_remaining_cents BIGINT;

CREATE INDEX IF NOT EXISTS idx_dra_agent_decided
  ON roadmap.dispatch_route_audit (agent_identity, decided_at DESC);

COMMENT ON TABLE roadmap.dispatch_route_audit IS
  'P842: Dispatch audit trail. budget_decision/budget_reject_reason/agent_budget_remaining_cents added by P842.';

COMMIT;
