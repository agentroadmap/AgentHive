-- Migration 117: P772 route_decision_log table
-- Audit log for model route selection decisions; records which route was chosen
-- and which were eliminated by each policy layer.

CREATE TABLE IF NOT EXISTS roadmap.route_decision_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint,
    role            text,
    agency_identity text,
    chosen_route_id integer,
    eliminated_routes jsonb NOT NULL DEFAULT '[]',
    decided_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_decision_log_proposal
    ON roadmap.route_decision_log (proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_decision_log_decided_at
    ON roadmap.route_decision_log (decided_at);
