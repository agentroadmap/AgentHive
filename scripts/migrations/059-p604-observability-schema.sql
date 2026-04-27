-- Migration: 059-p604-observability-schema.sql
-- P604: Observability schema — spans, lifecycle events, routing, explainability
--
-- All five tables live in roadmap.* during the single-DB transition (pre-P429).
-- The CREATE SCHEMA observability DDL is reserved for when hiveCentral is stood up.
--
-- Design notes:
--   trace_span: plain (unpartitioned) table. Range partitioning is deferred because
--     the self-referential parent_span_id FK cannot be declared across partition
--     boundaries in PostgreSQL.
--   agent_execution_span: model_name TEXT is stored denormalised (no FK) because
--     roadmap.model_metadata has a composite unique on (provider, model_name), not
--     a standalone unique on model_name alone. route_id FK is the authoritative link.
--   proposal_lifecycle_event: populated by trigger trg_proposal_lifecycle_event AND
--     by application code. triggered_by_did sourced from session variable app.agent_did.
--   model_routing_outcome / decision_explainability: trace_id is intentionally not
--     FK-constrained to trace_span — traces may originate from external systems.

BEGIN;

-- ─── 1. trace_span ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.trace_span (
  span_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id           UUID NOT NULL,
  parent_span_id     UUID REFERENCES roadmap.trace_span(span_id),
  operation          TEXT NOT NULL,        -- 'orch.dispatch' | 'agency.claim' | 'agent.tool_call'
  service_did        TEXT NOT NULL,        -- principal_identity format: 'agent:<identity>'
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  attributes         JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'ok',
    CONSTRAINT trace_span_status_check CHECK (status IN ('ok','error','cancelled')),
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_trace_span_trace_id     ON roadmap.trace_span(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_parent       ON roadmap.trace_span(parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trace_span_operation    ON roadmap.trace_span(operation);
CREATE INDEX IF NOT EXISTS idx_trace_span_started_at   ON roadmap.trace_span(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_trace_span_service_did  ON roadmap.trace_span(service_did);

-- ─── 2. agent_execution_span ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.agent_execution_span (
  span_id            UUID PRIMARY KEY REFERENCES roadmap.trace_span(span_id) ON DELETE CASCADE,
  agency_id          TEXT NOT NULL,          -- matches roadmap.agent_registry agency identifier
  agent_id           BIGINT NOT NULL,         -- matches roadmap.agent_registry.id (BIGSERIAL)
  proposal_id        BIGINT,                  -- display reference; may be in tenant DB
  project_id         BIGINT REFERENCES roadmap.project(project_id) ON DELETE SET NULL,
  model_name         TEXT,                    -- denormalised; no standalone unique on model_metadata.model_name
  route_id           BIGINT REFERENCES roadmap.model_routes(id) ON DELETE SET NULL,
  input_tokens       INT,
  output_tokens      INT,
  cost_usd           NUMERIC(12,8),
  briefing_id        UUID REFERENCES roadmap.spawn_briefing(briefing_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_aes_agency_id    ON roadmap.agent_execution_span(agency_id);
CREATE INDEX IF NOT EXISTS idx_aes_proposal_id  ON roadmap.agent_execution_span(proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aes_briefing_id  ON roadmap.agent_execution_span(briefing_id) WHERE briefing_id IS NOT NULL;

-- ─── 3. proposal_lifecycle_event ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.proposal_lifecycle_event (
  event_id           BIGSERIAL PRIMARY KEY,
  project_id         BIGINT REFERENCES roadmap.project(project_id) ON DELETE SET NULL,
  proposal_display_id TEXT NOT NULL,          -- e.g. 'P527'
  from_state         TEXT,
  to_state           TEXT NOT NULL,
  from_maturity      TEXT,
  to_maturity        TEXT NOT NULL,
  triggered_by_did   TEXT NOT NULL,           -- principal_identity format: 'agent:<identity>'
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  context            JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ple_display_id   ON roadmap.proposal_lifecycle_event(proposal_display_id);
CREATE INDEX IF NOT EXISTS idx_ple_occurred_at  ON roadmap.proposal_lifecycle_event(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ple_project_id   ON roadmap.proposal_lifecycle_event(project_id) WHERE project_id IS NOT NULL;

-- Trigger function: fires when proposal.status or proposal.maturity changes.
-- triggered_by_did comes from session variable app.agent_did (set by application
-- before the UPDATE). Falls back to app.agent_identity, then 'system'.
CREATE OR REPLACE FUNCTION roadmap.fn_proposal_lifecycle_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO roadmap.proposal_lifecycle_event (
    project_id,
    proposal_display_id,
    from_state,
    to_state,
    from_maturity,
    to_maturity,
    triggered_by_did,
    context
  ) VALUES (
    NEW.project_id,
    NEW.display_id,
    OLD.status,
    NEW.status,
    OLD.maturity,
    NEW.maturity,
    COALESCE(
      NULLIF(current_setting('app.agent_did', true), ''),
      NULLIF(current_setting('app.agent_identity', true), ''),
      'system'
    ),
    jsonb_build_object('source', 'trg_proposal_lifecycle_event')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_lifecycle_event ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_lifecycle_event
  AFTER UPDATE OF status, maturity ON roadmap_proposal.proposal
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.maturity IS DISTINCT FROM NEW.maturity)
  EXECUTE FUNCTION roadmap.fn_proposal_lifecycle_event();

-- ─── 4. model_routing_outcome ────────────────────────────────────────────────
-- trace_id not FK'd to trace_span: traces may originate from external systems.

CREATE TABLE IF NOT EXISTS roadmap.model_routing_outcome (
  outcome_id         BIGSERIAL PRIMARY KEY,
  trace_id           UUID NOT NULL,
  selected_route_id  BIGINT NOT NULL REFERENCES roadmap.model_routes(id) ON DELETE RESTRICT,
  candidate_routes   JSONB NOT NULL,   -- [{route_id, model_name, route_provider, priority, score, reason}]
  selection_reason   TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mro_trace_id    ON roadmap.model_routing_outcome(trace_id);
CREATE INDEX IF NOT EXISTS idx_mro_occurred_at ON roadmap.model_routing_outcome(occurred_at DESC);

-- ─── 5. decision_explainability ──────────────────────────────────────────────
-- trace_id not FK'd to trace_span: traces may originate from external systems.

CREATE TABLE IF NOT EXISTS roadmap.decision_explainability (
  decision_id        BIGSERIAL PRIMARY KEY,
  trace_id           UUID NOT NULL,
  decision_kind      TEXT NOT NULL,
    CONSTRAINT de_kind_check CHECK (decision_kind IN ('gate_advance','agent_assignment','budget_block','grant_check')),
  inputs             JSONB NOT NULL,
  rules_evaluated    JSONB NOT NULL,
  outcome            JSONB NOT NULL,
  ruleset_id         TEXT,             -- P607: stable hash of active PolicyEvaluator ruleset
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_de_trace_id      ON roadmap.decision_explainability(trace_id);
CREATE INDEX IF NOT EXISTS idx_de_kind          ON roadmap.decision_explainability(decision_kind);
CREATE INDEX IF NOT EXISTS idx_de_occurred_at   ON roadmap.decision_explainability(occurred_at DESC);

-- ─── 6. Role grants (roadmap_agent) — one GRANT per object, no duplicates ────

GRANT SELECT, INSERT ON roadmap.trace_span TO roadmap_agent;
GRANT SELECT, INSERT ON roadmap.agent_execution_span TO roadmap_agent;
GRANT SELECT, INSERT ON roadmap.proposal_lifecycle_event TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.proposal_lifecycle_event_event_id_seq TO roadmap_agent;
GRANT SELECT, INSERT ON roadmap.model_routing_outcome TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.model_routing_outcome_outcome_id_seq TO roadmap_agent;
GRANT SELECT, INSERT ON roadmap.decision_explainability TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.decision_explainability_decision_id_seq TO roadmap_agent;

COMMIT;
