-- ============================================================
-- P592 — hiveCentral.core schema
-- Bootstrap layer: installation singleton, host registry,
-- OS user registry, runtime feature flags, service heartbeat.
-- ============================================================
-- Target DB: hiveCentral
-- Owner: agenthive_admin
-- Roles granted: agenthive_orchestrator (rw subset), agenthive_observability (r),
--                agenthive_agency (r on flag, r on host)
-- ============================================================

CREATE SCHEMA IF NOT EXISTS core;

COMMENT ON SCHEMA core IS
  'Foundation layer for hiveCentral: installation singleton, hosts, OS users, '
  'runtime flags, service heartbeats. Every other central schema depends on core.';

-- ============================================================
-- core.installation — singleton (one row per hiveCentral install)
-- ============================================================
CREATE TABLE core.installation (
  installation_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name      TEXT         NOT NULL,
  bootstrapped_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  schema_version    TEXT         NOT NULL,             -- e.g. 'hivecentral-v3.0.0'
  control_db_name   TEXT         NOT NULL,             -- 'hiveCentral' by default; configurable
  metadata          JSONB        NOT NULL DEFAULT '{}',
  -- Catalog hygiene (uniform across all central catalogs):
  owner_did         TEXT         NOT NULL,
  lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at     TIMESTAMPTZ,
  retire_after      TIMESTAMPTZ,
  notes             TEXT
);

-- Singleton enforcement: exactly one active installation row at any time.
CREATE UNIQUE INDEX installation_singleton
  ON core.installation ((true))
  WHERE lifecycle_status = 'active';

COMMENT ON TABLE core.installation IS
  'Singleton row describing this hiveCentral install. Read by every service at boot.';

-- ============================================================
-- core.host — registered hosts that run AgentHive services
-- ============================================================
CREATE TABLE core.host (
  host_id           BIGSERIAL    PRIMARY KEY,
  host_name         TEXT         NOT NULL,             -- 'bot', 'hostA1', 'hostA2', etc.
  fqdn              TEXT,                              -- if applicable
  region            TEXT,                              -- region label for future multi-region
  failure_domain    TEXT,                              -- 'rack-1', 'az-east-1a', etc.
  role              TEXT         NOT NULL              -- 'control-plane' | 'tenant-db' | 'agency'
                                CHECK (role IN ('control-plane','tenant-db','agency','mixed')),
  cpu_cores         INT,
  memory_gb         INT,
  registered_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata          JSONB        NOT NULL DEFAULT '{}',
  -- Catalog hygiene:
  owner_did         TEXT         NOT NULL,
  lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at     TIMESTAMPTZ,
  retire_after      TIMESTAMPTZ,
  notes             TEXT,
  UNIQUE (host_name)
);

CREATE INDEX host_role_active ON core.host (role) WHERE lifecycle_status = 'active';

COMMENT ON TABLE core.host IS
  'Hosts registered with this installation. Referenced by core.os_user, agency.agency, '
  'project.project_db, project.project_host. Required for DR (failure_domain mapping).';

-- ============================================================
-- core.os_user — OS-level users that run AgentHive processes
-- ============================================================
CREATE TABLE core.os_user (
  os_user_id        BIGSERIAL    PRIMARY KEY,
  host_id           BIGINT       NOT NULL REFERENCES core.host (host_id) ON DELETE RESTRICT,
  user_name         TEXT         NOT NULL,             -- 'gary', 'agenthive_orchestrator', etc.
  uid               INT,                               -- numeric UID if known
  is_service_account BOOLEAN     NOT NULL DEFAULT false,
  shell             TEXT,
  home_dir          TEXT,
  registered_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata          JSONB        NOT NULL DEFAULT '{}',
  -- Catalog hygiene:
  owner_did         TEXT         NOT NULL,
  lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at     TIMESTAMPTZ,
  retire_after      TIMESTAMPTZ,
  notes             TEXT,
  UNIQUE (host_id, user_name)
);

COMMENT ON TABLE core.os_user IS
  'OS users on registered hosts. Agencies bind to a specific (host, os_user) pair so we '
  'know exactly which Linux user runs each agency process. Referenced by agency.agency.';

-- ============================================================
-- core.runtime_flag — DB-driven feature flags / runtime config
-- ============================================================
-- Layer 5 of the universal config resolver (§8 of redesign).
-- NOTIFY-based hot reload: services listen on `runtime_flag_changed`.
CREATE TABLE core.runtime_flag (
  flag_name         TEXT         NOT NULL,
  scope             TEXT         NOT NULL              -- 'global' | 'host:<id>' | 'agency:<id>' | 'project:<slug>'
                                CHECK (scope = 'global' OR scope ~ '^(host|agency|project):.+$'),
  value_jsonb       JSONB        NOT NULL,
  description       TEXT,
  modified_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  modified_by_did   TEXT         NOT NULL,
  -- Catalog hygiene:
  owner_did         TEXT         NOT NULL,
  lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                                CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at     TIMESTAMPTZ,
  retire_after      TIMESTAMPTZ,
  notes             TEXT,
  PRIMARY KEY (flag_name, scope)
);

CREATE INDEX runtime_flag_active ON core.runtime_flag (flag_name)
  WHERE lifecycle_status = 'active';

COMMENT ON TABLE core.runtime_flag IS
  'Runtime feature flags / config. Resolution precedence: CLI > env > /etc/agenthive/env > '
  'roadmap.yaml > runtime_flag (scope=global or scope=host:X or scope=agency:X or scope=project:slug) '
  '> hardcoded default. NOTIFY runtime_flag_changed fires on every UPDATE/INSERT.';

-- Trigger: NOTIFY on change so services can hot-reload their cache
CREATE OR REPLACE FUNCTION core.notify_runtime_flag_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'runtime_flag_changed',
    json_build_object(
      'flag_name', COALESCE(NEW.flag_name, OLD.flag_name),
      'scope', COALESCE(NEW.scope, OLD.scope),
      'op', TG_OP
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER runtime_flag_change_notify
  AFTER INSERT OR UPDATE OR DELETE ON core.runtime_flag
  FOR EACH ROW
  EXECUTE FUNCTION core.notify_runtime_flag_change();

-- ============================================================
-- core.service_heartbeat — DR signal source
-- ============================================================
-- Services write a row every 30s (configurable via runtime_flag).
-- DR detector reads this; lag > 60s on > 2 services = primary suspected dead.
-- Note: also published via systemd sd_notify so DR detection works even if PG is dead.
CREATE TABLE core.service_heartbeat (
  service_id        TEXT         PRIMARY KEY,         -- 'orchestrator-1', 'copilot-agency', etc.
  host_id           BIGINT       NOT NULL REFERENCES core.host (host_id),
  pid               INT          NOT NULL,
  started_at        TIMESTAMPTZ  NOT NULL,
  last_beat_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status            TEXT         NOT NULL              -- 'starting' | 'active' | 'draining' | 'stopped'
                                CHECK (status IN ('starting','active','draining','stopped')),
  metadata          JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX service_heartbeat_recent ON core.service_heartbeat (last_beat_at);
CREATE INDEX service_heartbeat_by_host ON core.service_heartbeat (host_id);

COMMENT ON TABLE core.service_heartbeat IS
  'Per-service heartbeat. Updated every 30s by each AgentHive process. Source signal for DR '
  'detection. Also fed to systemd sd_notify so monitoring works even when PG is unreachable.';

-- ============================================================
-- Views for common queries
-- ============================================================
CREATE OR REPLACE VIEW core.v_active_hosts AS
SELECT host_id, host_name, fqdn, region, failure_domain, role, cpu_cores, memory_gb
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
  FROM core.service_heartbeat s
  JOIN core.host h ON h.host_id = s.host_id;

COMMENT ON VIEW core.v_service_health IS
  'Service health view used by DR detector and operator dashboards. health = healthy | '
  'degraded (60s+ silence) | silent (90s+ silence) | inactive (status says so).';

-- ============================================================
-- Grants
-- ============================================================
-- Roles will be created in P530.0 bootstrap (separate file).
-- Grants here use IF EXISTS so the file can run before role creation.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.runtime_flag, core.service_heartbeat TO agenthive_orchestrator;
    GRANT SELECT ON core.host, core.os_user, core.installation TO agenthive_orchestrator;
    GRANT SELECT ON core.v_active_hosts, core.v_service_health TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA core TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_agency;
    GRANT SELECT ON core.runtime_flag, core.host TO agenthive_agency;
    GRANT INSERT, UPDATE ON core.service_heartbeat TO agenthive_agency;
  END IF;
END $$;

-- ============================================================
-- Seed: bootstrap installation row (singleton)
-- ============================================================
-- Inserted only on fresh DB; idempotent.
INSERT INTO core.installation (display_name, schema_version, control_db_name, owner_did)
SELECT
  'AgentHive primary',
  'hivecentral-v3.0.0',
  current_database(),
  'did:hive:bootstrap'
WHERE NOT EXISTS (SELECT 1 FROM core.installation WHERE lifecycle_status = 'active');
