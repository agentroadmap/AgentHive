-- Migration 059: Observability Schema (P604)
--
-- Creates five tables in the roadmap schema:
--   trace_span, agent_execution_span, proposal_lifecycle_event,
--   model_routing_outcome, decision_explainability
--
-- Future home: hiveCentral.observability (deferred to P429).
-- No dependency on migration 058 / P472 (P472 has no migration file yet).
-- FKs checked: model_routes, model_metadata, project, spawn_briefing must exist.

BEGIN;

-- ── Preflight: verify FK target tables exist ─────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
  ) THEN
    RAISE EXCEPTION 'migration 059 requires roadmap.model_routes (migration 025)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap' AND table_name = 'model_metadata'
  ) THEN
    RAISE EXCEPTION 'migration 059 requires roadmap.model_metadata (migration 027)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap' AND table_name = 'project'
  ) THEN
    RAISE EXCEPTION 'migration 059 requires roadmap.project (migration 050)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap' AND table_name = 'spawn_briefing'
  ) THEN
    RAISE EXCEPTION 'migration 059 requires roadmap.spawn_briefing';
  END IF;
END;
$$;

-- ── 1. trace_span ─────────────────────────────────────────────────────────────
--
-- Plain unpartitioned table. Range partitioning deferred — the self-referential
-- parent_span_id FK cannot be declared across partition boundaries in PostgreSQL.
-- Retention via DELETE on started_at (see section 6).

CREATE TABLE IF NOT EXISTS roadmap.trace_span (
  span_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id           UUID        NOT NULL,
  parent_span_id     UUID        REFERENCES roadmap.trace_span(span_id),
  operation          TEXT        NOT NULL,
  service_did        TEXT        NOT NULL,
    CONSTRAINT trace_span_service_did_check
      CHECK (service_did ~ '^(agent|agency|operator):'),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  attributes         JSONB       NOT NULL DEFAULT '{}',
  status             TEXT        NOT NULL DEFAULT 'ok',
    CONSTRAINT trace_span_status_check
      CHECK (status IN ('ok','error','cancelled')),
  error_message      TEXT
);

COMMENT ON TABLE roadmap.trace_span IS
  'P604: Root span table. One row per operation unit. Parent/child linked via parent_span_id.';
COMMENT ON COLUMN roadmap.trace_span.service_did IS
  'Principal identity of the service writing the span (agent:|agency:|operator: prefix).';
COMMENT ON COLUMN roadmap.trace_span.ended_at IS
  'NULL while span is open. Written at agent exit via UPDATE. Open spans (ended_at IS NULL) survive crashes.';

-- ── 2. agent_execution_span ───────────────────────────────────────────────────
--
-- agent_id BIGINT NOT NULL — matches roadmap.agent_runs.id (per-execution instance).
-- No FK constraint on agent_id — intentional, to avoid coupling to agent_runs
-- schema evolution. agent_registry.id is a permanent identity record and is NOT
-- what this column stores.
-- model_name stored denormalised (no FK) — model_metadata has only composite
-- UNIQUE (provider, model_name), not a standalone unique on model_name.
-- route_id is the authoritative FK for route identification.

CREATE TABLE IF NOT EXISTS roadmap.agent_execution_span (
  span_id            UUID        PRIMARY KEY REFERENCES roadmap.trace_span(span_id) ON DELETE CASCADE,
  agency_id          TEXT        NOT NULL,
  agent_id           BIGINT      NOT NULL,  -- roadmap.agent_runs.id; no FK by design
  proposal_id        BIGINT,
  project_id         BIGINT      REFERENCES roadmap.project(project_id) ON DELETE SET NULL,
  model_name         TEXT,
  route_id           BIGINT      REFERENCES roadmap.model_routes(id) ON DELETE SET NULL,
  input_tokens       INT,
  output_tokens      INT,
  cost_usd           NUMERIC(12,8),
  briefing_id        UUID        REFERENCES roadmap.spawn_briefing(briefing_id) ON DELETE SET NULL
);

COMMENT ON TABLE roadmap.agent_execution_span IS
  'P604: Per-agent execution detail. Extends trace_span with token telemetry, cost, and route info.';
COMMENT ON COLUMN roadmap.agent_execution_span.agent_id IS
  'roadmap.agent_runs.id — per-execution instance, not agent_registry.id (permanent identity).';

-- ── 3. proposal_lifecycle_event ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.proposal_lifecycle_event (
  event_id              BIGSERIAL   PRIMARY KEY,
  project_id            BIGINT      REFERENCES roadmap.project(project_id) ON DELETE SET NULL,
  proposal_display_id   TEXT        NOT NULL,
  from_state            TEXT,
  to_state              TEXT        NOT NULL,
  from_maturity         TEXT,
  to_maturity           TEXT        NOT NULL,
  triggered_by_did      TEXT        NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  context               JSONB       NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE roadmap.proposal_lifecycle_event IS
  'P604: Immutable audit trail of proposal state/maturity transitions. Retained indefinitely.';

-- Trigger function: fires AFTER UPDATE OF status, maturity on roadmap_proposal.proposal
CREATE OR REPLACE FUNCTION roadmap.fn_proposal_lifecycle_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO roadmap.proposal_lifecycle_event (
    project_id, proposal_display_id, from_state, to_state,
    from_maturity, to_maturity, triggered_by_did, context
  ) VALUES (
    NEW.project_id, NEW.display_id, OLD.status, NEW.status,
    OLD.maturity, NEW.maturity,
    COALESCE(
      NULLIF(current_setting('app.agent_did', true), ''),
      NULLIF(current_setting('app.agent_identity', true), ''),
      'system'
    ),
    jsonb_build_object('source', 'trg_proposal_lifecycle_event')
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_proposal_lifecycle_event ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_lifecycle_event
  AFTER UPDATE OF status, maturity ON roadmap_proposal.proposal
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.maturity IS DISTINCT FROM NEW.maturity)
  EXECUTE FUNCTION roadmap.fn_proposal_lifecycle_event();

-- ── 4. model_routing_outcome ──────────────────────────────────────────────────
--
-- trace_id not FK-constrained — traces may originate from external systems.

CREATE TABLE IF NOT EXISTS roadmap.model_routing_outcome (
  outcome_id         BIGSERIAL   PRIMARY KEY,
  trace_id           UUID        NOT NULL,
  selected_route_id  BIGINT      NOT NULL REFERENCES roadmap.model_routes(id) ON DELETE RESTRICT,
  candidate_routes   JSONB       NOT NULL,
  selection_reason   TEXT        NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.model_routing_outcome IS
  'P604: Records which route was selected and why. Retained indefinitely as governance record.';
COMMENT ON COLUMN roadmap.model_routing_outcome.trace_id IS
  'No FK — traces may originate from external (OTLP) systems.';

-- ── 5. decision_explainability ────────────────────────────────────────────────
--
-- trace_id not FK-constrained — traces may originate from external systems.
-- ruleset_id added per P607 requirement for replay.

CREATE TABLE IF NOT EXISTS roadmap.decision_explainability (
  decision_id        BIGSERIAL   PRIMARY KEY,
  trace_id           UUID        NOT NULL,
  decision_kind      TEXT        NOT NULL,
    CONSTRAINT de_kind_check
      CHECK (decision_kind IN ('gate_advance','agent_assignment','budget_block','grant_check')),
  inputs             JSONB       NOT NULL,
  rules_evaluated    JSONB       NOT NULL,
  outcome            JSONB       NOT NULL,
  ruleset_id         TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.decision_explainability IS
  'P604: Explains every gate/routing/budget decision. Retained indefinitely. ruleset_id for P607 replay.';
COMMENT ON COLUMN roadmap.decision_explainability.trace_id IS
  'No FK — traces may originate from external (OTLP) systems.';

-- ── 6. Indexes (16 total) ─────────────────────────────────────────────────────
--
-- trace_span (4): trace lookup, retention deletes, subtree queries, error filtering

CREATE INDEX IF NOT EXISTS idx_trace_span_trace_id
  ON roadmap.trace_span(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_span_started_at
  ON roadmap.trace_span(started_at);
CREATE INDEX IF NOT EXISTS idx_trace_span_parent_span_id
  ON roadmap.trace_span(parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trace_span_status_err
  ON roadmap.trace_span(status) WHERE status != 'ok';

-- agent_execution_span (5): all FK columns indexed for join performance

CREATE INDEX IF NOT EXISTS idx_aes_proposal
  ON roadmap.agent_execution_span(proposal_id);
CREATE INDEX IF NOT EXISTS idx_aes_agency
  ON roadmap.agent_execution_span(agency_id);
CREATE INDEX IF NOT EXISTS idx_aes_route
  ON roadmap.agent_execution_span(route_id);
CREATE INDEX IF NOT EXISTS idx_aes_project
  ON roadmap.agent_execution_span(project_id);
CREATE INDEX IF NOT EXISTS idx_aes_briefing
  ON roadmap.agent_execution_span(briefing_id);

-- proposal_lifecycle_event (3): display_id lookup, project filter, timeline sort

CREATE INDEX IF NOT EXISTS idx_ple_display_id
  ON roadmap.proposal_lifecycle_event(proposal_display_id);
CREATE INDEX IF NOT EXISTS idx_ple_project
  ON roadmap.proposal_lifecycle_event(project_id);
CREATE INDEX IF NOT EXISTS idx_ple_occurred_at
  ON roadmap.proposal_lifecycle_event(occurred_at);

-- model_routing_outcome (2): trace lookup, route join

CREATE INDEX IF NOT EXISTS idx_mro_trace_id
  ON roadmap.model_routing_outcome(trace_id);
CREATE INDEX IF NOT EXISTS idx_mro_route
  ON roadmap.model_routing_outcome(selected_route_id);

-- decision_explainability (2): trace lookup, kind filter

CREATE INDEX IF NOT EXISTS idx_de_trace
  ON roadmap.decision_explainability(trace_id);
CREATE INDEX IF NOT EXISTS idx_de_kind
  ON roadmap.decision_explainability(decision_kind);

-- ── 7. Role grants ────────────────────────────────────────────────────────────
--
-- roadmap_agent: SELECT + INSERT on all five tables; UPDATE on closeable columns
--   of trace_span (AC-13: span close writes ended_at, status, error_message).
-- admin_write: DELETE on trace_span + agent_execution_span for retention cron
--   (proposal_lifecycle_event, model_routing_outcome, decision_explainability
--   are retained indefinitely — no DELETE grant).

-- trace_span
GRANT SELECT, INSERT ON roadmap.trace_span TO roadmap_agent;
GRANT UPDATE (ended_at, status, error_message) ON roadmap.trace_span TO roadmap_agent;
GRANT DELETE ON roadmap.trace_span TO admin_write;

-- agent_execution_span
GRANT SELECT, INSERT ON roadmap.agent_execution_span TO roadmap_agent;
GRANT DELETE ON roadmap.agent_execution_span TO admin_write;

-- proposal_lifecycle_event (trigger writes as session user — no direct INSERT grant needed,
-- but roadmap_agent reads the audit trail)
GRANT SELECT, INSERT ON roadmap.proposal_lifecycle_event TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.proposal_lifecycle_event_event_id_seq TO roadmap_agent;

-- model_routing_outcome
GRANT SELECT, INSERT ON roadmap.model_routing_outcome TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.model_routing_outcome_outcome_id_seq TO roadmap_agent;

-- decision_explainability
GRANT SELECT, INSERT ON roadmap.decision_explainability TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.decision_explainability_decision_id_seq TO roadmap_agent;

COMMIT;

-- ── Verification queries ──────────────────────────────────────────────────────
-- Confirm tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'roadmap'
--   AND table_name IN ('trace_span','agent_execution_span','proposal_lifecycle_event',
--                      'model_routing_outcome','decision_explainability')
-- ORDER BY table_name;
--
-- Confirm trigger installed:
-- SELECT trigger_name, event_manipulation, event_object_schema, event_object_table
-- FROM information_schema.triggers
-- WHERE trigger_name = 'trg_proposal_lifecycle_event';
--
-- Confirm UPDATE grant on trace_span:
-- SELECT grantee, privilege_type, column_name
-- FROM information_schema.role_column_grants
-- WHERE table_schema = 'roadmap' AND table_name = 'trace_span'
--   AND privilege_type = 'UPDATE';
