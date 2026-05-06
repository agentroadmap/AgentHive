-- ============================================================
-- agentHive2 — 005-observability.sql
-- Observability layer: trace spans, agent execution spans,
-- proposal lifecycle events, model routing outcomes, and
-- decision explainability (P604 ported to agentHive2).
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql, 002-agency.sql
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS observability;
COMMENT ON SCHEMA observability IS
  'Observability layer: trace spans, agent execution spans, lifecycle events, '
  'routing decisions, and explainability. Replaces coarse-grained governance.event '
  'for debugging autonomous dispatch, span causality, and decision replay.';

-- ============================================================
-- observability.trace_span — distributed trace spans
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.trace_span (
  span_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id           UUID          NOT NULL,
  parent_span_id     UUID          REFERENCES observability.trace_span(span_id) ON DELETE CASCADE,
  operation          TEXT          NOT NULL,
  service_did        TEXT          NOT NULL,
    CONSTRAINT trace_span_service_did_check
      CHECK (service_did ~ '^(agent|agency|operator):'),
  started_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  attributes         JSONB         NOT NULL DEFAULT '{}',
  status             TEXT          NOT NULL DEFAULT 'ok',
    CONSTRAINT trace_span_status_check
      CHECK (status IN ('ok', 'error', 'cancelled')),
  error_message      TEXT
);

COMMENT ON TABLE observability.trace_span IS
  'Distributed trace spans. Self-referential parent_span_id for causality. '
  'Plain unpartitioned table (range partitioning deferred due to self-FK).';

CREATE INDEX IF NOT EXISTS idx_trace_span_trace_id
  ON observability.trace_span(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_started_at
  ON observability.trace_span(started_at);
CREATE INDEX IF NOT EXISTS idx_trace_span_parent_span_id
  ON observability.trace_span(parent_span_id)
  WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trace_span_status_err
  ON observability.trace_span(status)
  WHERE status != 'ok';

-- ============================================================
-- observability.agent_execution_span — agent-specific span data
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.agent_execution_span (
  span_id            UUID          PRIMARY KEY REFERENCES observability.trace_span(span_id) ON DELETE CASCADE,
  agency_id          TEXT          NOT NULL,
  agent_id           BIGINT        NOT NULL,
  proposal_id        BIGINT,
  project_id         BIGINT        REFERENCES core.project(id) ON DELETE SET NULL,
  model_name         TEXT,
  route_id           BIGINT        REFERENCES agency.route(id) ON DELETE SET NULL,
  input_tokens       INT,
  output_tokens      INT,
  cost_usd           NUMERIC(12, 8),
  briefing_id        UUID
);

COMMENT ON TABLE observability.agent_execution_span IS
  'Agent-specific execution context. agent_id is per-execution instance (no FK). '
  'model_name denormalised (route_id FK is authoritative). briefing_id links to dispatch record.';

CREATE INDEX IF NOT EXISTS idx_aes_proposal
  ON observability.agent_execution_span(proposal_id);
CREATE INDEX IF NOT EXISTS idx_aes_agency
  ON observability.agent_execution_span(agency_id);
CREATE INDEX IF NOT EXISTS idx_aes_route
  ON observability.agent_execution_span(route_id);
CREATE INDEX IF NOT EXISTS idx_aes_project
  ON observability.agent_execution_span(project_id);
CREATE INDEX IF NOT EXISTS idx_aes_briefing
  ON observability.agent_execution_span(briefing_id);
CREATE INDEX IF NOT EXISTS idx_aes_agent_id
  ON observability.agent_execution_span(agent_id);

-- ============================================================
-- observability.proposal_lifecycle_event — proposal state transitions
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.proposal_lifecycle_event (
  event_id           BIGSERIAL     PRIMARY KEY,
  project_id         BIGINT        REFERENCES core.project(id) ON DELETE SET NULL,
  proposal_display_id TEXT         NOT NULL,
  from_state         TEXT,
  to_state           TEXT          NOT NULL,
  from_maturity      TEXT,
  to_maturity        TEXT          NOT NULL,
  triggered_by_did   TEXT          NOT NULL,
  occurred_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  context            JSONB         NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE observability.proposal_lifecycle_event IS
  'Append-only log of proposal state transitions. Populated by per-project trigger '
  'on :schema_name.proposal UPDATE OF status, maturity.';

CREATE INDEX IF NOT EXISTS idx_ple_display_id
  ON observability.proposal_lifecycle_event(proposal_display_id);
CREATE INDEX IF NOT EXISTS idx_ple_project
  ON observability.proposal_lifecycle_event(project_id);
CREATE INDEX IF NOT EXISTS idx_ple_occurred_at
  ON observability.proposal_lifecycle_event(occurred_at);

-- ============================================================
-- observability.model_routing_outcome — route selection decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.model_routing_outcome (
  outcome_id         BIGSERIAL     PRIMARY KEY,
  trace_id           UUID          NOT NULL,
  selected_route_id  BIGINT        NOT NULL REFERENCES agency.route(id) ON DELETE RESTRICT,
  candidate_routes   JSONB         NOT NULL,
  selection_reason   TEXT          NOT NULL,
  occurred_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.model_routing_outcome IS
  'Model routing decisions: which route was selected, why, and alternatives. '
  'trace_id not FK-constrained (may originate from external systems).';

CREATE INDEX IF NOT EXISTS idx_mro_trace_id
  ON observability.model_routing_outcome(trace_id);
CREATE INDEX IF NOT EXISTS idx_mro_route
  ON observability.model_routing_outcome(selected_route_id);

-- ============================================================
-- observability.decision_explainability — gate and policy decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.decision_explainability (
  decision_id        BIGSERIAL     PRIMARY KEY,
  trace_id           UUID          NOT NULL,
  decision_kind      TEXT          NOT NULL,
    CONSTRAINT de_kind_check
      CHECK (decision_kind IN ('gate_advance', 'agent_assignment', 'budget_block', 'grant_check')),
  inputs             JSONB         NOT NULL,
  rules_evaluated    JSONB         NOT NULL,
  outcome            JSONB         NOT NULL,
  ruleset_id         TEXT,
  occurred_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.decision_explainability IS
  'Decision logic audit trail: inputs, rules, outcomes for gate advances, '
  'agent assignments, budget blocks, grant checks. Indefinite retention.';

CREATE INDEX IF NOT EXISTS idx_de_trace
  ON observability.decision_explainability(trace_id);
CREATE INDEX IF NOT EXISTS idx_de_kind
  ON observability.decision_explainability(decision_kind);

-- ============================================================
-- Role Grants
-- ============================================================

-- agenthive_orchestrator: SELECT, INSERT, UPDATE (span-close)
GRANT SELECT, INSERT ON observability.trace_span TO agenthive_orchestrator;
GRANT UPDATE (ended_at, status, error_message) ON observability.trace_span TO agenthive_orchestrator;
GRANT SELECT, INSERT ON observability.agent_execution_span TO agenthive_orchestrator;
GRANT SELECT, INSERT ON observability.proposal_lifecycle_event TO agenthive_orchestrator;
GRANT USAGE ON SEQUENCE observability.proposal_lifecycle_event_event_id_seq TO agenthive_orchestrator;
GRANT SELECT, INSERT ON observability.model_routing_outcome TO agenthive_orchestrator;
GRANT USAGE ON SEQUENCE observability.model_routing_outcome_outcome_id_seq TO agenthive_orchestrator;
GRANT SELECT, INSERT ON observability.decision_explainability TO agenthive_orchestrator;
GRANT USAGE ON SEQUENCE observability.decision_explainability_decision_id_seq TO agenthive_orchestrator;

-- agenthive_observability: SELECT-only
GRANT SELECT ON observability.trace_span TO agenthive_observability;
GRANT SELECT ON observability.agent_execution_span TO agenthive_observability;
GRANT SELECT ON observability.proposal_lifecycle_event TO agenthive_observability;
GRANT SELECT ON observability.model_routing_outcome TO agenthive_observability;
GRANT SELECT ON observability.decision_explainability TO agenthive_observability;

-- agenthive_agency: INSERT (span-write)
GRANT SELECT, INSERT ON observability.trace_span TO agenthive_agency;
GRANT SELECT, INSERT ON observability.agent_execution_span TO agenthive_agency;
GRANT SELECT, INSERT ON observability.model_routing_outcome TO agenthive_agency;
GRANT SELECT, INSERT ON observability.decision_explainability TO agenthive_agency;

-- agenthive_admin: DELETE (retention cron)
GRANT DELETE ON observability.trace_span TO agenthive_admin;
GRANT DELETE ON observability.agent_execution_span TO agenthive_admin;
