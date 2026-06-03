-- P194: Project and agent memory tables
-- project_memory lives in efficiency schema (shared platform knowledge, cacheable)
-- agent_memory lives in workforce schema (per-agent episodic/semantic/working/procedural)

-- ── project_memory ────────────────────────────────────────────────────────────

CREATE TABLE efficiency.project_memory (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text    NOT NULL,
  category    text    NOT NULL CHECK (category IN ('architecture', 'workflow', 'conventions', 'glossary', 'schema')),
  content     jsonb   NOT NULL DEFAULT '{}',
  version     int     NOT NULL DEFAULT 1,
  is_cached   bool    NOT NULL DEFAULT false,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_memory_key_uq UNIQUE (key)
);

COMMENT ON TABLE efficiency.project_memory IS
  'P194: Shared, stable platform context. Stable rows are cacheable as system-prompt prefix.';

-- ── agent_memory ──────────────────────────────────────────────────────────────

CREATE TABLE workforce.agent_memory (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_identity text    NOT NULL,
  layer          text    NOT NULL CHECK (layer IN ('episodic', 'semantic', 'working', 'procedural')),
  key            text    NOT NULL,
  value          text    NOT NULL,
  metadata       jsonb,
  ttl_seconds    int,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_identity_layer_key_uq UNIQUE (agent_identity, layer, key)
);

CREATE INDEX agent_memory_identity_layer ON workforce.agent_memory (agent_identity, layer);
CREATE INDEX agent_memory_expires ON workforce.agent_memory (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE workforce.agent_memory IS
  'P194: Per-agent episodic/semantic/working/procedural memory with optional TTL.';

-- ── v_active_memory: non-expired rows only ───────────────────────────────────

CREATE VIEW workforce.v_active_memory AS
  SELECT id, agent_identity, layer, key, value, metadata, ttl_seconds, expires_at, created_at, updated_at
  FROM workforce.agent_memory
  WHERE expires_at IS NULL OR expires_at > now();

COMMENT ON VIEW workforce.v_active_memory IS
  'P194: Active (non-expired) agent memory entries.';

-- ── Seed project_memory with 5 canonical keys ────────────────────────────────

INSERT INTO efficiency.project_memory (key, category, content, is_cached) VALUES
(
  'architecture',
  'architecture',
  '{
    "pillars": ["identity", "orchestration", "agency", "messaging", "memory"],
    "data_layer": "hiveCentral PostgreSQL with schema-per-domain partitioning",
    "messaging": "A2A bus via messaging.a2a_message + LISTEN/NOTIFY channels",
    "event_streams": {
      "lifecycle": "observability.proposal_lifecycle_event",
      "audit": "governance.event_log",
      "liaison": "agency.liaison_message",
      "route": "observability.model_routing_outcome"
    }
  }',
  true
),
(
  'workflow_states',
  'workflow',
  '{
    "states": ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"],
    "maturity": ["new", "active", "mature", "obsolete"],
    "transitions": {
      "DRAFT->REVIEW": "RFC coherence gate",
      "REVIEW->DEVELOP": "acceptance criteria defined",
      "DEVELOP->MERGE": "AC passed, tests green",
      "MERGE->COMPLETE": "e2e verified on main"
    }
  }',
  true
),
(
  'conventions',
  'conventions',
  '{
    "schema_prefix": "domain-per-schema (efficiency, workforce, agency, messaging, governance, observability)",
    "migration_naming": "NNN-pID-slug.sql",
    "commit_style": "feat|fix|chore(PXXX): description",
    "memory_layers": ["episodic", "semantic", "working", "procedural"],
    "event_sources": ["governance.event_log", "observability.proposal_lifecycle_event", "agency.liaison_message"]
  }',
  true
),
(
  'glossary',
  'glossary',
  '{
    "agency": "A named cluster of AI agents sharing a provider route and liaison",
    "liaison": "Standing process bridging orchestrator and agency worker pool",
    "offer": "Orchestrator-created lease opportunity for an agent to claim work",
    "briefing": "Warm-boot context package assembled before spawn",
    "maturity": "Progressive readiness signal within a workflow state"
  }',
  false
),
(
  'schema_summary',
  'schema',
  '{
    "efficiency": ["project_memory", "cost_ledger_summary", "efficiency_metric", "route_token_budget"],
    "workforce": ["agent", "agent_memory", "agent_skill", "v_active_memory"],
    "agency": ["agency", "agency_session", "liaison_message"],
    "messaging": ["a2a_message", "a2a_dlq", "a2a_subscription"],
    "governance": ["event_log", "decision_log", "policy_version"],
    "observability": ["proposal_lifecycle_event", "agent_execution_span", "model_routing_outcome"]
  }',
  false
)
ON CONFLICT (key) DO NOTHING;

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON efficiency.project_memory TO agenthive_orchestrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.agent_memory TO agenthive_orchestrator;
GRANT SELECT ON workforce.v_active_memory TO agenthive_orchestrator;

GRANT SELECT ON efficiency.project_memory TO agenthive_agency;
GRANT SELECT ON workforce.v_active_memory TO agenthive_agency;

GRANT SELECT, INSERT, UPDATE ON efficiency.project_memory TO agent_write;
GRANT SELECT, INSERT, UPDATE, DELETE ON workforce.agent_memory TO agent_write;
GRANT SELECT ON workforce.v_active_memory TO agent_write;

GRANT SELECT ON efficiency.project_memory TO agent_read;
GRANT SELECT ON workforce.v_active_memory TO agent_read;
