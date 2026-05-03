-- ============================================================
-- agentHive2 — 001-core.sql
-- Control-plane foundation: installation singleton, hosts,
-- OS users, runtime flags, service heartbeats, runtime endpoints.
-- Also creates the `dev` ephemeral sandbox schema.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- dev schema — ephemeral sandbox; NEVER referenced in deploy/
-- ============================================================
CREATE SCHEMA IF NOT EXISTS dev;
COMMENT ON SCHEMA dev IS
  'Ephemeral sandbox for ad-hoc exploration and temporary objects. '
  'Never referenced in deploy/. Drop freely. '
  'CI lint: grep -rn dev\. deploy/ && exit 1';

-- ============================================================
-- core schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS core;
COMMENT ON SCHEMA core IS
  'Foundation layer: installation singleton, hosts, OS users, '
  'runtime flags, service heartbeats, runtime endpoint registry. '
  'Every other control-plane schema depends on core.';

-- Shared updated_at trigger function
CREATE OR REPLACE FUNCTION core.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ============================================================
-- core.installation — singleton (one row per agentHive2 install)
-- ============================================================
CREATE TABLE IF NOT EXISTS core.installation (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name     TEXT         NOT NULL,
  bootstrapped_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  schema_version   TEXT         NOT NULL,
  db_name          TEXT         NOT NULL DEFAULT current_database(),
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

CREATE UNIQUE INDEX IF NOT EXISTS installation_singleton
  ON core.installation ((true))
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_installation
  BEFORE UPDATE ON core.installation
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.installation IS
  'Singleton row. Read by every service at boot to confirm DB identity and version.';

-- ============================================================
-- core.host — registered compute hosts
-- ============================================================
CREATE TABLE IF NOT EXISTS core.host (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_name        TEXT         NOT NULL UNIQUE,
  fqdn             TEXT,
  region           TEXT,
  failure_domain   TEXT,
  role             TEXT         NOT NULL
                               CHECK (role IN ('control-plane','tenant-db','agency','mixed')),
  cpu_cores        INT,
  memory_gb        INT,
  registered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
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

CREATE INDEX IF NOT EXISTS host_role_active ON core.host (role) WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_host
  BEFORE UPDATE ON core.host
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.host IS
  'Hosts registered with this installation. Referenced by core.osUser and agency tables.';

-- ============================================================
-- core.osUser — OS-level users running AgentHive processes
-- ============================================================
CREATE TABLE IF NOT EXISTS core.osUser (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id          BIGINT       NOT NULL REFERENCES core.host (id) ON DELETE RESTRICT,
  user_name        TEXT         NOT NULL,
  uid              INT,
  is_service_acct  BOOLEAN      NOT NULL DEFAULT false,
  shell            TEXT,
  home_dir         TEXT,
  registered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (host_id, user_name)
);

CREATE OR REPLACE TRIGGER set_updated_at_osuser
  BEFORE UPDATE ON core.osUser
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.osUser IS
  'OS users on registered hosts. Agencies bind to (host, osUser) so the exact Linux user per agency process is known.';

-- ============================================================
-- core.project — project registry (pointer to per-project schema)
-- ============================================================
CREATE TABLE IF NOT EXISTS core.project (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,        -- 'agentHive', 'hardcodeMiner', etc.
  display_name     TEXT         NOT NULL,
  schema_name      TEXT         NOT NULL UNIQUE,        -- Postgres schema holding project tables
  description      TEXT,
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

CREATE INDEX IF NOT EXISTS project_active ON core.project (slug) WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_project
  BEFORE UPDATE ON core.project
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.project IS
  'Project registry. Each project maps to a schema in this database. '
  'Add a row here before running deploy/project-init/ for that project.';

-- ============================================================
-- core.runtimeFlag — DB-driven feature flags
-- ============================================================
CREATE TABLE IF NOT EXISTS core.runtimeFlag (
  flag_name        TEXT         NOT NULL,
  scope            TEXT         NOT NULL
                               CHECK (scope = 'global' OR scope ~ '^(host|agency|project):.+$'),
  value_jsonb      JSONB        NOT NULL,
  description      TEXT,
  modified_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  modified_by_did  TEXT         NOT NULL,
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_name, scope)
);

CREATE INDEX IF NOT EXISTS runtime_flag_active ON core.runtimeFlag (flag_name)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE FUNCTION core.notify_runtime_flag_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'runtime_flag_changed',
    json_build_object(
      'flag_name', COALESCE(NEW.flag_name, OLD.flag_name),
      'scope',     COALESCE(NEW.scope, OLD.scope),
      'op',        TG_OP,
      'new_value', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.value_jsonb END
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE TRIGGER runtime_flag_change_notify
  AFTER INSERT OR UPDATE OR DELETE ON core.runtimeFlag
  FOR EACH ROW EXECUTE FUNCTION core.notify_runtime_flag_change();

CREATE OR REPLACE TRIGGER set_updated_at_runtimeflag
  BEFORE UPDATE ON core.runtimeFlag
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.runtimeFlag IS
  'Runtime feature flags. Scope: global | host:<id> | agency:<id> | project:<slug>. '
  'Emits pg_notify(runtime_flag_changed) on every mutation for hot-reload.';

-- ============================================================
-- core.serviceHeartbeat — service liveness signal
-- ============================================================
-- No catalog hygiene columns: rows are replaced on conflict; no lifecycle concept applies.
CREATE TABLE IF NOT EXISTS core.serviceHeartbeat (
  service_id       TEXT         PRIMARY KEY,
  host_id          BIGINT       NOT NULL REFERENCES core.host (id),
  pid              INT          NOT NULL,
  started_at       TIMESTAMPTZ  NOT NULL,
  last_beat_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status           TEXT         NOT NULL
                               CHECK (status IN ('starting','active','draining','stopped')),
  metadata         JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS service_heartbeat_recent ON core.serviceHeartbeat (last_beat_at);
CREATE INDEX IF NOT EXISTS service_heartbeat_by_host ON core.serviceHeartbeat (host_id);

COMMENT ON TABLE core.serviceHeartbeat IS
  'Per-service heartbeat. Updated every 30s. Source signal for DR detection.';

-- ============================================================
-- core.runtimeEndpoint — canonical service endpoint registry
-- ============================================================
CREATE TABLE IF NOT EXISTS core.runtimeEndpoint (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_key      TEXT         NOT NULL UNIQUE,
  url              TEXT         NOT NULL,
  host_id          BIGINT       REFERENCES core.host (id) ON DELETE SET NULL,
  port             INT,
  protocol         TEXT         NOT NULL DEFAULT 'http'
                               CHECK (protocol IN ('http','https','grpc','sse')),
  owner_did        TEXT,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_endpoint_active
  ON core.runtimeEndpoint (service_key)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE FUNCTION core.notify_runtime_endpoint_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'runtime_endpoint_changed',
    json_build_object(
      'service_key', COALESCE(NEW.service_key, OLD.service_key),
      'url',         CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.url END,
      'op',          TG_OP
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE TRIGGER runtime_endpoint_change_notify
  AFTER INSERT OR UPDATE OR DELETE ON core.runtimeEndpoint
  FOR EACH ROW EXECUTE FUNCTION core.notify_runtime_endpoint_change();

CREATE OR REPLACE TRIGGER set_updated_at_runtime_endpoint
  BEFORE UPDATE ON core.runtimeEndpoint
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.runtimeEndpoint IS
  'Canonical runtime endpoint registry. Resolution order: env var → this table → hard fail. '
  'Emits pg_notify(runtime_endpoint_changed) on mutation.';

-- ============================================================
-- Views
-- ============================================================
CREATE OR REPLACE VIEW core.v_active_hosts AS
SELECT id, host_name, fqdn, region, failure_domain, role, cpu_cores, memory_gb
  FROM core.host
 WHERE lifecycle_status = 'active';

CREATE OR REPLACE VIEW core.v_service_health AS
SELECT
  s.service_id,
  s.host_id,
  h.host_name,
  s.status,
  s.last_beat_at,
  EXTRACT(EPOCH FROM (now() - s.last_beat_at))::int AS seconds_since_beat,
  CASE
    WHEN s.status IN ('stopped','draining') THEN 'inactive'
    WHEN now() - s.last_beat_at > interval '90 seconds' THEN 'silent'
    WHEN now() - s.last_beat_at > interval '60 seconds' THEN 'degraded'
    ELSE 'healthy'
  END AS health
  FROM core.serviceHeartbeat s
  JOIN core.host h ON h.id = s.host_id;

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.runtimeFlag, core.serviceHeartbeat TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.runtimeEndpoint TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.project TO agenthive_orchestrator;
    GRANT SELECT ON core.host, core.osUser, core.installation TO agenthive_orchestrator;
    GRANT SELECT ON core.v_active_hosts, core.v_service_health TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA core TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_agency;
    GRANT SELECT ON core.runtimeFlag, core.host, core.osUser, core.runtimeEndpoint, core.project TO agenthive_agency;
    GRANT INSERT, UPDATE ON core.serviceHeartbeat TO agenthive_agency;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_a2a') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_a2a;
    GRANT SELECT ON core.runtimeFlag, core.runtimeEndpoint TO agenthive_a2a;
    GRANT INSERT, UPDATE ON core.serviceHeartbeat TO agenthive_a2a;
  END IF;
END $$;

-- ============================================================
-- Seed
-- ============================================================
INSERT INTO core.installation (display_name, schema_version, owner_did)
SELECT 'AgentHive primary', 'agenthive2-v1.0.0', 'did:agenthive:bootstrap'
WHERE NOT EXISTS (SELECT 1 FROM core.installation WHERE lifecycle_status = 'active');

INSERT INTO core.runtimeEndpoint (service_key, url, protocol, owner_did)
VALUES
  ('mcp',    'http://127.0.0.1:6421/sse', 'sse',  'did:agenthive:system'),
  ('daemon', 'http://127.0.0.1:3000',     'http', 'did:agenthive:system')
ON CONFLICT (service_key) DO NOTHING;
