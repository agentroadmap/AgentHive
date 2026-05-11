-- ============================================================
-- agentHive2 — 005-observability.sql
-- Observability schema: distributed trace spans, agent execution
-- metrics, proposal lifecycle events, model routing outcomes,
-- and decision explainability.
-- Ported from P604 into agentHive2 as a control-plane schema.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql (core.project), 002-agency.sql (agency.route)
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- observability schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS observability;
COMMENT ON SCHEMA observability IS
  'Observability bounded context: distributed trace spans, agent execution '
  'metrics, proposal lifecycle events, model routing outcomes, and decision '
  'explainability. Sibling to core, agency, identity, governance schemas. '
  'Retention: trace_span and agent_execution_span are 30d; others indefinite.';

-- ============================================================
-- observability roles: grant USAGE
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA observability TO agenthive_observability;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_app') THEN
    GRANT USAGE ON SCHEMA observability TO agenthive_app;
  END IF;
END $$;

-- ============================================================
-- 1. observability.trace_span — distributed trace root
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.trace_span (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trace_id        TEXT NOT NULL,
    span_id         TEXT NOT NULL,
    parent_span_id  TEXT,
    operation       TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    duration_ms     INTEGER GENERATED ALWAYS AS (
                        EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                    ) STORED,
    status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
    attributes      JSONB NOT NULL DEFAULT '{}',
    project_id      BIGINT REFERENCES core.project(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.trace_span IS
  'Distributed trace root for causality and replay. '
  'Self-FK on parent_span_id without range partitioning (deferred per P604). '
  'Retention: 30d DELETE via cron job.';

CREATE UNIQUE INDEX IF NOT EXISTS trace_span_trace_span_uidx
  ON observability.trace_span (trace_id, span_id);
CREATE INDEX IF NOT EXISTS trace_span_trace_id_idx
  ON observability.trace_span (trace_id);
CREATE INDEX IF NOT EXISTS trace_span_started_at_idx
  ON observability.trace_span (started_at DESC);
CREATE INDEX IF NOT EXISTS trace_span_project_idx
  ON observability.trace_span (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trace_span_status_idx
  ON observability.trace_span (status) WHERE status IN ('error', 'timeout');

GRANT SELECT, INSERT ON observability.trace_span TO agenthive_observability;

-- ============================================================
-- 2. observability.agent_execution_span — per-agent task window
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.agent_execution_span (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    span_id         TEXT NOT NULL,
    trace_id        TEXT NOT NULL,
    agent_identity  TEXT NOT NULL,
    proposal_id     TEXT,
    task_id         TEXT,
    route_id        BIGINT REFERENCES agency.route(id) ON DELETE SET NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    exit_status     TEXT CHECK (exit_status IN ('success','error','timeout','cancelled')),
    tokens_used     INTEGER,
    cost_usd        NUMERIC(10,6),
    attributes      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.agent_execution_span IS
  'Per-agent task execution window. Spans the entire lifecycle from start to termination. '
  'Retention: 30d DELETE via cron job.';

CREATE UNIQUE INDEX IF NOT EXISTS agent_exec_span_span_uidx
  ON observability.agent_execution_span (span_id);
CREATE INDEX IF NOT EXISTS agent_exec_span_trace_idx
  ON observability.agent_execution_span (trace_id);
CREATE INDEX IF NOT EXISTS agent_exec_span_agent_idx
  ON observability.agent_execution_span (agent_identity);
CREATE INDEX IF NOT EXISTS agent_exec_span_proposal_idx
  ON observability.agent_execution_span (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_exec_span_started_idx
  ON observability.agent_execution_span (started_at DESC);
CREATE INDEX IF NOT EXISTS agent_exec_span_exit_status_idx
  ON observability.agent_execution_span (exit_status) WHERE exit_status IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON observability.agent_execution_span TO agenthive_observability;

-- ============================================================
-- 3. observability.proposal_lifecycle_event — state transitions
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.proposal_lifecycle_event (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     TEXT NOT NULL,
    project_id      BIGINT REFERENCES core.project(id) ON DELETE CASCADE,
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    from_maturity   TEXT,
    to_maturity     TEXT,
    changed_by      TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    attributes      JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.proposal_lifecycle_event IS
  'Proposal status and maturity state transitions. Populated by per-project trigger '
  'on roadmap.proposal UPDATE. Retention: indefinite (governance-class event).';

CREATE INDEX IF NOT EXISTS proposal_lifecycle_proposal_idx
  ON observability.proposal_lifecycle_event (proposal_id);
CREATE INDEX IF NOT EXISTS proposal_lifecycle_project_idx
  ON observability.proposal_lifecycle_event (project_id);
CREATE INDEX IF NOT EXISTS proposal_lifecycle_occurred_idx
  ON observability.proposal_lifecycle_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS proposal_lifecycle_status_idx
  ON observability.proposal_lifecycle_event (from_status, to_status);

GRANT SELECT, INSERT ON observability.proposal_lifecycle_event TO agenthive_observability;

-- ============================================================
-- 4. observability.model_routing_outcome — route selection result
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.model_routing_outcome (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    span_id             TEXT NOT NULL,
    selected_route_id   BIGINT REFERENCES agency.route(id) ON DELETE SET NULL,
    model_id            TEXT NOT NULL,
    provider            TEXT NOT NULL,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    total_tokens        INTEGER GENERATED ALWAYS AS (
                            COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)
                        ) STORED,
    latency_ms          INTEGER,
    cost_usd            NUMERIC(10,6),
    success             BOOLEAN NOT NULL DEFAULT true,
    error_code          TEXT,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.model_routing_outcome IS
  'Record of model route selection and resulting token usage, latency, and cost. '
  'Retention: indefinite (governance-class event).';

CREATE INDEX IF NOT EXISTS model_routing_span_idx
  ON observability.model_routing_outcome (span_id);
CREATE INDEX IF NOT EXISTS model_routing_route_idx
  ON observability.model_routing_outcome (selected_route_id) WHERE selected_route_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS model_routing_occurred_idx
  ON observability.model_routing_outcome (occurred_at DESC);
CREATE INDEX IF NOT EXISTS model_routing_provider_idx
  ON observability.model_routing_outcome (provider);
CREATE INDEX IF NOT EXISTS model_routing_success_idx
  ON observability.model_routing_outcome (success);

GRANT SELECT, INSERT ON observability.model_routing_outcome TO agenthive_observability;

-- ============================================================
-- 5. observability.decision_explainability — decision reasoning
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.decision_explainability (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_id     BIGINT,
    span_id         TEXT,
    proposal_id     TEXT,
    decision_type   TEXT NOT NULL,
    reasoning       TEXT NOT NULL,
    confidence      NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
    inputs          JSONB NOT NULL DEFAULT '{}',
    outputs         JSONB NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE observability.decision_explainability IS
  'Why the orchestrator made a specific decision. Captures reasoning, confidence, '
  'inputs, and outputs for decision-tree replay and model training. '
  'Retention: indefinite (governance-class event).';

CREATE INDEX IF NOT EXISTS decision_explain_proposal_idx
  ON observability.decision_explainability (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_explain_span_idx
  ON observability.decision_explainability (span_id) WHERE span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_explain_occurred_idx
  ON observability.decision_explainability (occurred_at DESC);
CREATE INDEX IF NOT EXISTS decision_explain_type_idx
  ON observability.decision_explainability (decision_type);

GRANT SELECT, INSERT ON observability.decision_explainability TO agenthive_observability;

-- ============================================================
-- Final grants for SELECT access (agenthive_app, etc.)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_app') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA observability TO agenthive_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA observability TO agenthive_orchestrator;
    GRANT UPDATE ON observability.trace_span TO agenthive_orchestrator;
  END IF;
END $$;
