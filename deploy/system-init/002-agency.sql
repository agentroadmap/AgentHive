-- ============================================================
-- agentHive2 — 002-agency.sql
-- Agency providers, model catalog, routing, host policies,
-- agent sessions, and liaison messaging.
-- Merges hiveCentral's `agency` + `control_model` schemas.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql (core.host, core.osUser)
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS agency;
COMMENT ON SCHEMA agency IS
  'LLM agency providers, model catalog, routing policies, '
  'agent sessions, and liaison messaging. Combines what hiveCentral '
  'split across agency + control_model schemas.';

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION agency.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ============================================================
-- agency.provider — LLM provider catalog (Anthropic, OpenAI, …)
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.provider (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,         -- 'claude', 'codex', 'hermes', 'copilot'
  display_name     TEXT         NOT NULL,
  api_base_url     TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER set_updated_at_provider
  BEFORE UPDATE ON agency.provider
  FOR EACH ROW EXECUTE FUNCTION agency.set_updated_at();

COMMENT ON TABLE agency.provider IS
  'LLM provider catalog. slug is the canonical identifier used in model routes and policies.';

-- ============================================================
-- agency.model — LLM model catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.model (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id      BIGINT       NOT NULL REFERENCES agency.provider (id) ON DELETE RESTRICT,
  model_id         TEXT         NOT NULL UNIQUE,         -- 'claude-sonnet-4-6', 'gpt-4o', etc.
  display_name     TEXT         NOT NULL,
  context_window   INT,
  supports_tools   BOOLEAN      NOT NULL DEFAULT true,
  input_cost_per_1k  NUMERIC(10,6),
  output_cost_per_1k NUMERIC(10,6),
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_provider_active ON agency.model (provider_id)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_model
  BEFORE UPDATE ON agency.model
  FOR EACH ROW EXECUTE FUNCTION agency.set_updated_at();

COMMENT ON TABLE agency.model IS
  'LLM model catalog. model_id is the string passed to the provider API.';

-- ============================================================
-- agency.route — enabled routes (model + provider + host)
-- ============================================================
-- host is a soft TEXT FK to allow bootstrapping before core.host is seeded.
CREATE TABLE IF NOT EXISTS agency.route (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id         BIGINT       NOT NULL REFERENCES agency.model (id) ON DELETE RESTRICT,
  host             TEXT         NOT NULL,                -- matches core.host.host_name
  priority         INT          NOT NULL DEFAULT 100,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (model_id, host)
);

CREATE INDEX IF NOT EXISTS route_active ON agency.route (host)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_route
  BEFORE UPDATE ON agency.route
  FOR EACH ROW EXECUTE FUNCTION agency.set_updated_at();

COMMENT ON TABLE agency.route IS
  'Enabled model routes per host. host is a soft FK (TEXT) to allow seeding before core.host rows exist.';

-- ============================================================
-- agency.hostPolicy — per-host routing policy
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.hostPolicy (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host             TEXT         NOT NULL,                -- matches core.host.host_name
  route_id         BIGINT       REFERENCES agency.route (id) ON DELETE SET NULL,
  policy_jsonb     JSONB        NOT NULL DEFAULT '{}',   -- allowed_providers, cost_limits, etc.
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS host_policy_host_active ON agency.hostPolicy (host)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_hostpolicy
  BEFORE UPDATE ON agency.hostPolicy
  FOR EACH ROW EXECUTE FUNCTION agency.set_updated_at();

COMMENT ON TABLE agency.hostPolicy IS
  'Per-host routing policy. Controls which providers/routes are permitted on a given host.';

-- ============================================================
-- agency.agency — registered agency instances
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.agency (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id      BIGINT       NOT NULL REFERENCES agency.provider (id) ON DELETE RESTRICT,
  host_id          BIGINT       REFERENCES core.host (id) ON DELETE SET NULL,
  os_user_id       BIGINT       REFERENCES core.osUser (id) ON DELETE SET NULL,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  slug             TEXT         NOT NULL UNIQUE,         -- 'claude-bot', 'codex-worktree-1', etc.
  display_name     TEXT         NOT NULL,
  socket_path      TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_provider_active ON agency.agency (provider_id)
  WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS agency_project ON agency.agency (project_id);

CREATE OR REPLACE TRIGGER set_updated_at_agency
  BEFORE UPDATE ON agency.agency
  FOR EACH ROW EXECUTE FUNCTION agency.set_updated_at();

COMMENT ON TABLE agency.agency IS
  'Registered agency instances. Binds a provider to a specific host + OS user + project scope.';

-- ============================================================
-- agency.session — agency session log (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.session (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  agency_id        BIGINT       NOT NULL REFERENCES agency.agency (id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  model_id         BIGINT       REFERENCES agency.model (id) ON DELETE SET NULL,
  input_tokens     INT          NOT NULL DEFAULT 0,
  output_tokens    INT          NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  exit_reason      TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE IF NOT EXISTS agency.session_default
  PARTITION OF agency.session DEFAULT;

COMMENT ON TABLE agency.session IS
  'Agency session log. Partitioned by started_at for efficient time-range queries.';

-- ============================================================
-- agency.msgKind — liaison message type catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.msgKind (
  kind             TEXT         PRIMARY KEY,
  description      TEXT         NOT NULL,
  schema_jsonb     JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE agency.msgKind IS
  'Catalog of liaison message types. kind is the discriminator used in agency.msg.';

-- ============================================================
-- agency.msg — agent-to-liaison messages (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.msg (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  agency_id        BIGINT       NOT NULL REFERENCES agency.agency (id) ON DELETE CASCADE,
  kind             TEXT         NOT NULL REFERENCES agency.msgKind (kind),
  payload_jsonb    JSONB        NOT NULL,
  sent_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  PRIMARY KEY (id, sent_at)
) PARTITION BY RANGE (sent_at);

CREATE TABLE IF NOT EXISTS agency.msg_default
  PARTITION OF agency.msg DEFAULT;

COMMENT ON TABLE agency.msg IS
  'Agent-to-liaison messages. Partitioned by sent_at.';

-- ============================================================
-- Views
-- ============================================================
CREATE OR REPLACE VIEW agency.v_active_routes AS
SELECT
  r.id,
  r.host,
  r.priority,
  m.model_id,
  m.display_name AS model_name,
  p.slug AS provider_slug
FROM agency.route r
JOIN agency.model m ON m.id = r.model_id
JOIN agency.provider p ON p.id = m.provider_id
WHERE r.lifecycle_status = 'active'
  AND m.lifecycle_status = 'active'
  AND p.lifecycle_status = 'active';

CREATE OR REPLACE VIEW agency.v_host_routing AS
SELECT
  hp.host,
  hp.policy_jsonb,
  r.id AS route_id,
  m.model_id,
  p.slug AS provider_slug
FROM agency.hostPolicy hp
LEFT JOIN agency.route r ON r.id = hp.route_id
LEFT JOIN agency.model m ON m.id = r.model_id
LEFT JOIN agency.provider p ON p.id = m.provider_id
WHERE hp.lifecycle_status = 'active';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA agency TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA agency TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_agency;
    GRANT SELECT ON agency.provider, agency.model, agency.route, agency.hostPolicy TO agenthive_agency;
    GRANT SELECT, INSERT, UPDATE ON agency.agency, agency.session, agency.msg TO agenthive_agency;
    GRANT SELECT ON agency.msgKind TO agenthive_agency;
    GRANT SELECT ON agency.v_active_routes, agency.v_host_routing TO agenthive_agency;
  END IF;
END $$;
