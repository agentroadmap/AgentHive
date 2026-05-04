-- Migration 097: P772 — route_decision_log audit table
--
-- Captures the full eligibility decision per dispatch:
--   chosen_route_id  — the model_routes row that won selection
--   eliminated_routes — JSONB array of routes excluded by each policy layer
--   Reason values: host_policy | project_policy | agency_policy | role_policy | budget_exhausted
--
-- Fire-and-forget INSERT added in resolveModelRoute() (agent-spawner.ts).
-- Retention: prune rows older than 30 days via scheduled job (P773+).

BEGIN;

CREATE TABLE roadmap.route_decision_log (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id       BIGINT,
  role              TEXT,
  agency_identity   TEXT,
  chosen_route_id   BIGINT REFERENCES roadmap.model_routes(id),
  eliminated_routes JSONB,
  -- [{route_id, route_provider, reason}] where reason ∈ host_policy|project_policy|agency_policy|role_policy|budget_exhausted
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_route_decision_log_proposal
  ON roadmap.route_decision_log (proposal_id, decided_at DESC);

CREATE INDEX idx_route_decision_log_recent
  ON roadmap.route_decision_log (decided_at DESC);

GRANT SELECT             ON roadmap.route_decision_log TO agent_read;
GRANT SELECT, INSERT     ON roadmap.route_decision_log TO agent_write;

COMMENT ON TABLE roadmap.route_decision_log IS
  'Audit trail: one row per resolveModelRoute() call, recording chosen route and why competitors were eliminated.';

COMMIT;
