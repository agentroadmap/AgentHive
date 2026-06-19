-- ============================================================
-- 013-observability: Distributed tracing + execution telemetry schema
-- All tables are append-only and partitioned monthly.
-- ============================================================
-- owner_did exempt (AC-1, whole schema): every table here is an append-only,
-- monthly-partitioned event/metric stream (REVOKE UPDATE,DELETE + deny-mutation
-- trigger on each). These are telemetry rows, not managed catalog entities — there
-- is no owner to retire/deprecate, and per-row hygiene columns would waste I/O on a
-- high-volume write path. Provenance is carried in-row (agency_id / actor_agency_id /
-- trigger_source). Exempt tables: trace_span, agent_execution_span,
-- proposal_lifecycle_event, model_routing_outcome, decision_explainability.
-- Target DB:  hiveCentral
-- Owner:      agenthive_admin
-- Roles:      agenthive_orchestrator (r all),
--             agenthive_agency (r all, w trace_span/agent_execution_span/proposal_lifecycle_event/model_routing_outcome/decision_explainability),
--             agenthive_observability (r all)
-- Min PG:     16
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS observability;

COMMENT ON SCHEMA observability IS
  'Distributed tracing and execution telemetry. All tables are append-only and partitioned '
  'monthly. Covers trace spans, per-agent execution cost, proposal lifecycle events, '
  'model routing outcomes (P747 D6), and routing decision explainability.';

-- ============================================================
-- Shared append-only guard: deny_observability_mutation()
-- Each table gets its own instance for clear error messages.
-- ============================================================

-- ============================================================
-- observability.trace_span — distributed trace spans (90d)
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.trace_span (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY,
  trace_id       UUID         NOT NULL,
  span_id        UUID         NOT NULL,
  parent_span_id UUID,
  agency_id      BIGINT,
  project_id     BIGINT,
  operation      TEXT,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  status         TEXT         CHECK (status IN ('ok','error','timeout','cancelled')),
  attributes     JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS trace_span_trace_id
  ON observability.trace_span (trace_id);
CREATE INDEX IF NOT EXISTS trace_span_project_created
  ON observability.trace_span (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trace_span_agency_created
  ON observability.trace_span (agency_id, created_at DESC);

REVOKE UPDATE, DELETE ON observability.trace_span FROM PUBLIC;

CREATE OR REPLACE FUNCTION observability.deny_trace_span_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observability.trace_span is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER trace_span_no_update
  BEFORE UPDATE ON observability.trace_span
  FOR EACH ROW EXECUTE FUNCTION observability.deny_trace_span_mutation();

CREATE OR REPLACE TRIGGER trace_span_no_delete
  BEFORE DELETE ON observability.trace_span
  FOR EACH ROW EXECUTE FUNCTION observability.deny_trace_span_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'observability.trace_span',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '90 days', retention_keep_table = false
  WHERE parent_table = 'observability.trace_span';

COMMENT ON TABLE observability.trace_span IS
  'Distributed trace spans. trace_id groups all spans for a single end-to-end request. '
  'parent_span_id NULL indicates a root span. Partitioned monthly; 90-day retention.';

-- ============================================================
-- observability.agent_execution_span — per-agent execution cost (90d)
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.agent_execution_span (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY,
  trace_span_id   BIGINT       NOT NULL,   -- soft FK to trace_span.id
  proposal_id     BIGINT,
  agency_id       BIGINT,
  role            TEXT,
  tokens_in       BIGINT,
  tokens_out      BIGINT,
  cost_usd        NUMERIC(12,6),
  model_route_id  BIGINT
                  REFERENCES control_model.model_route (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS agent_execution_span_trace_span
  ON observability.agent_execution_span (trace_span_id);
CREATE INDEX IF NOT EXISTS agent_execution_span_project_created
  ON observability.agent_execution_span (proposal_id, created_at DESC);

REVOKE UPDATE, DELETE ON observability.agent_execution_span FROM PUBLIC;

CREATE OR REPLACE FUNCTION observability.deny_agent_execution_span_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observability.agent_execution_span is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER agent_execution_span_no_update
  BEFORE UPDATE ON observability.agent_execution_span
  FOR EACH ROW EXECUTE FUNCTION observability.deny_agent_execution_span_mutation();

CREATE OR REPLACE TRIGGER agent_execution_span_no_delete
  BEFORE DELETE ON observability.agent_execution_span
  FOR EACH ROW EXECUTE FUNCTION observability.deny_agent_execution_span_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'observability.agent_execution_span',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '90 days', retention_keep_table = false
  WHERE parent_table = 'observability.agent_execution_span';

COMMENT ON TABLE observability.agent_execution_span IS
  'Per-agent execution cost telemetry linked to distributed traces. '
  'trace_span_id is a soft FK (partitioned tables cannot have FKs in PG16). '
  'Partitioned monthly; 90-day retention.';

-- ============================================================
-- observability.proposal_lifecycle_event — proposal state changes (permanent)
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.proposal_lifecycle_event (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  proposal_id      BIGINT       NOT NULL,
  project_id       BIGINT       NOT NULL,
  old_status       TEXT,
  new_status       TEXT,
  old_maturity     TEXT,
  new_maturity     TEXT,
  actor_agency_id  BIGINT,
  trigger_source   TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS proposal_lifecycle_event_proposal_created
  ON observability.proposal_lifecycle_event (proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proposal_lifecycle_event_project_created
  ON observability.proposal_lifecycle_event (project_id, created_at DESC);

REVOKE UPDATE, DELETE ON observability.proposal_lifecycle_event FROM PUBLIC;

CREATE OR REPLACE FUNCTION observability.deny_proposal_lifecycle_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observability.proposal_lifecycle_event is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER proposal_lifecycle_event_no_update
  BEFORE UPDATE ON observability.proposal_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION observability.deny_proposal_lifecycle_event_mutation();

CREATE OR REPLACE TRIGGER proposal_lifecycle_event_no_delete
  BEFORE DELETE ON observability.proposal_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION observability.deny_proposal_lifecycle_event_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'observability.proposal_lifecycle_event',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
-- Permanent: no retention set

COMMENT ON TABLE observability.proposal_lifecycle_event IS
  'Permanent record of every proposal status/maturity transition. Partitioned monthly '
  'for query performance but no pruning (permanent audit log). proposal_id and project_id '
  'are soft FKs to the tenant DB.';

-- ============================================================
-- observability.model_routing_outcome — route picker decisions (90d) — P747 D6
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.model_routing_outcome (
  id           BIGINT       GENERATED ALWAYS AS IDENTITY,
  proposal_id  BIGINT,
  agency_id    BIGINT,
  route_id     BIGINT
               REFERENCES control_model.model_route (id) ON DELETE SET NULL,
  decision     TEXT         NOT NULL CHECK (decision IN ('allowed','denied','fallback')),
  reason_code  TEXT,
  latency_ms   INT,
  project_id   BIGINT       NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS model_routing_outcome_project_created
  ON observability.model_routing_outcome (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_routing_outcome_route_created
  ON observability.model_routing_outcome (route_id, created_at DESC);

REVOKE UPDATE, DELETE ON observability.model_routing_outcome FROM PUBLIC;

CREATE OR REPLACE FUNCTION observability.deny_model_routing_outcome_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observability.model_routing_outcome is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER model_routing_outcome_no_update
  BEFORE UPDATE ON observability.model_routing_outcome
  FOR EACH ROW EXECUTE FUNCTION observability.deny_model_routing_outcome_mutation();

CREATE OR REPLACE TRIGGER model_routing_outcome_no_delete
  BEFORE DELETE ON observability.model_routing_outcome
  FOR EACH ROW EXECUTE FUNCTION observability.deny_model_routing_outcome_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'observability.model_routing_outcome',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '90 days', retention_keep_table = false
  WHERE parent_table = 'observability.model_routing_outcome';

COMMENT ON TABLE observability.model_routing_outcome IS
  'Route picker decision log (P747 D6). Every allowed/denied/fallback decision is recorded '
  'here for cost attribution, policy auditing, and explainability. Partitioned monthly; '
  '90-day retention.';

-- ============================================================
-- observability.decision_explainability — routing decision layers (90d)
-- ============================================================
CREATE TABLE IF NOT EXISTS observability.decision_explainability (
  id                  BIGINT       GENERATED ALWAYS AS IDENTITY,
  routing_outcome_id  BIGINT       NOT NULL,   -- soft FK to model_routing_outcome.id
  layer               TEXT         NOT NULL,   -- 'host_policy','agency_policy','project_policy','budget'
  filter_name         TEXT,
  input_value         JSONB,
  output_value        JSONB,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS decision_explainability_routing_outcome
  ON observability.decision_explainability (routing_outcome_id);
CREATE INDEX IF NOT EXISTS decision_explainability_project_created
  ON observability.decision_explainability (created_at DESC);

REVOKE UPDATE, DELETE ON observability.decision_explainability FROM PUBLIC;

CREATE OR REPLACE FUNCTION observability.deny_decision_explainability_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observability.decision_explainability is append-only (op=%)', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER decision_explainability_no_update
  BEFORE UPDATE ON observability.decision_explainability
  FOR EACH ROW EXECUTE FUNCTION observability.deny_decision_explainability_mutation();

CREATE OR REPLACE TRIGGER decision_explainability_no_delete
  BEFORE DELETE ON observability.decision_explainability
  FOR EACH ROW EXECUTE FUNCTION observability.deny_decision_explainability_mutation();

SELECT partman.create_parent(
  p_parent_table    => 'observability.decision_explainability',
  p_control         => 'created_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '90 days', retention_keep_table = false
  WHERE parent_table = 'observability.decision_explainability';

COMMENT ON TABLE observability.decision_explainability IS
  'Per-layer breakdown of each route picker decision. routing_outcome_id is a soft FK '
  '(partitioned table). layer values: host_policy, agency_policy, project_policy, budget. '
  'Partitioned monthly; 90-day retention.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA observability TO agenthive_orchestrator;
    GRANT SELECT ON ALL TABLES IN SCHEMA observability TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA observability TO agenthive_agency;
    GRANT SELECT ON ALL TABLES IN SCHEMA observability TO agenthive_agency;
    GRANT INSERT ON
      observability.trace_span,
      observability.agent_execution_span,
      observability.proposal_lifecycle_event,
      observability.model_routing_outcome,
      observability.decision_explainability
    TO agenthive_agency;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA observability TO agenthive_agency;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA observability TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA observability TO agenthive_observability;
  END IF;
END $$;

\echo 'observability schema applied.'
