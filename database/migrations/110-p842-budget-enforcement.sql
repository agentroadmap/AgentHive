-- P842: Hard Budget Enforcement per Agent (Principal-Based Spending Caps)
--
-- Phase 1: Schema Foundation
--
-- Two tables:
--  1. principal_spending_cap: hard spending caps per principal/project/period
--  2. dispatch_route_audit: audit trail of dispatch decisions (referenced by allowlist-check.ts:263)

-- Table 1: Hard spending caps per principal
CREATE TABLE IF NOT EXISTS roadmap.principal_spending_cap (
  principal_id             TEXT        NOT NULL
    REFERENCES roadmap.principal_identity(principal_id) ON DELETE CASCADE,
  project_id               TEXT        NOT NULL,
  period                   TEXT        NOT NULL
    CHECK (period IN ('day', 'week', 'month', 'total')),
  max_usd_cents            BIGINT      NOT NULL,
  current_spent_usd_cents  BIGINT      NOT NULL DEFAULT 0,
  last_reset_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_id, project_id, period)
);
CREATE INDEX IF NOT EXISTS idx_psc_principal_project ON roadmap.principal_spending_cap(principal_id, project_id);

-- Table 2: Dispatch audit trail
-- Referenced by src/shared/dispatch/allowlist-check.ts:263
-- Columns match the INSERT statement in allowlist-check.ts lines 263-276
-- Plus 3 new P842 columns for budget decision tracking
CREATE TABLE IF NOT EXISTS roadmap.dispatch_route_audit (
  id                          BIGSERIAL   PRIMARY KEY,
  project_id                  TEXT        NOT NULL,
  route_name                  TEXT        NOT NULL,
  capability_name             TEXT        NOT NULL,
  decision                    TEXT        NOT NULL
    CHECK (decision IN ('allow','deny_route','deny_capability','deny_budget','deny_compliance')),
  reason                      TEXT        NOT NULL,
  remaining_budget_cents      BIGINT,
  agency_identity             TEXT,
  agent_identity              TEXT,
  budget_decision             TEXT
    CHECK (budget_decision IN ('approved','rejected') OR budget_decision IS NULL),
  budget_reject_reason        TEXT
    CHECK (budget_reject_reason IN ('project_cap','agent_cap') OR budget_reject_reason IS NULL),
  agent_budget_remaining_cents BIGINT,
  decided_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dra_project_decided ON roadmap.dispatch_route_audit(project_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_dra_agent_decided ON roadmap.dispatch_route_audit(agent_identity, decided_at DESC);
