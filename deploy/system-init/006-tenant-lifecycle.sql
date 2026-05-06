-- ============================================================
-- agentHive2 — 006-tenant-lifecycle.sql
-- Tenant lifecycle state machine for schema-per-project topology.
-- P893: Ported from P601's DB-per-tenant design.
--
-- Tables:
--   core.tenant_lifecycle — state machine per project schema
--   core.tenant_lifecycle_event — append-only audit log
--   core.tenant_backup — backup catalog
--
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.tenant_lifecycle — project schema lifecycle state machine
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_lifecycle (
  project_id       BIGINT       NOT NULL PRIMARY KEY REFERENCES core.project (id) ON DELETE RESTRICT,
  state            TEXT         NOT NULL
                               CHECK (state IN ('requested', 'provisioning', 'active', 'upgrading', 'archived', 'retiring', 'retired', 'failed')),
  state_reason     TEXT,
  ddl_version      INT          NOT NULL DEFAULT 1,
  backup_policy    JSONB        NOT NULL DEFAULT '{"schedule": "0 2 * * 0", "retention_days": 30, "target": "file:///var/lib/agentHive/backups"}',
  resource_quota   JSONB        NOT NULL DEFAULT '{"max_connections": 100, "max_schema_size_gb": 50, "statement_timeout_ms": 300000}',
  owner_did        TEXT         NOT NULL,
  state_changed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_state ON core.tenant_lifecycle (state);
CREATE INDEX IF NOT EXISTS tenant_lifecycle_state_changed ON core.tenant_lifecycle (state_changed_at DESC);

-- Deny mutations on lifecycle rows except via state machine transaction.
-- Trigger will be created after functions are defined.

COMMENT ON TABLE core.tenant_lifecycle IS
  'Project schema lifecycle state machine. One row per project. '
  'Schema-per-project model: state tracks provisioning, archival, retirement of the schema, not a separate DB.';

COMMENT ON COLUMN core.tenant_lifecycle.state IS
  'Lifecycle state: requested, provisioning, active, upgrading, archived, retiring, retired, failed.';

COMMENT ON COLUMN core.tenant_lifecycle.ddl_version IS
  'Schema DDL version. Bumped on every upgrade (active → upgrading → active).';

COMMENT ON COLUMN core.tenant_lifecycle.backup_policy IS
  'Backup configuration: {schedule: cron_expr, retention_days: int, target: uri}.';

COMMENT ON COLUMN core.tenant_lifecycle.resource_quota IS
  'Resource constraints: {max_connections: int, max_schema_size_gb: float, statement_timeout_ms: int}.';

-- ============================================================
-- core.tenant_lifecycle_event — append-only audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_lifecycle_event (
  event_id         BIGSERIAL    PRIMARY KEY,
  project_id       BIGINT       NOT NULL REFERENCES core.project (id) ON DELETE RESTRICT,
  from_state       TEXT,
  to_state         TEXT         NOT NULL,
  triggered_by_did TEXT         NOT NULL,
  context          JSONB        NOT NULL DEFAULT '{}',
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_event_project ON core.tenant_lifecycle_event (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS tenant_lifecycle_event_occurred ON core.tenant_lifecycle_event (occurred_at DESC);

-- Deny mutations (DELETE/UPDATE) on lifecycle events.
CREATE OR REPLACE FUNCTION core.deny_mutation_tenant_lifecycle_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'tenant_lifecycle_event is append-only; % denied', TG_OP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tenant_lifecycle_event_immutable
  BEFORE UPDATE OR DELETE ON core.tenant_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation_tenant_lifecycle_event();

COMMENT ON TABLE core.tenant_lifecycle_event IS
  'Append-only audit log. Every state transition is logged with context.';

-- ============================================================
-- core.tenant_backup — backup catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup (
  backup_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       BIGINT       NOT NULL REFERENCES core.project (id) ON DELETE RESTRICT,
  taken_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  backup_kind      TEXT         NOT NULL
                               CHECK (backup_kind IN ('logical', 'physical', 'snapshot')),
  storage_uri      TEXT         NOT NULL,
  size_bytes       BIGINT       NOT NULL,
  retention_until  TIMESTAMPTZ  NOT NULL,
  verified_at      TIMESTAMPTZ,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS tenant_backup_project_taken ON core.tenant_backup (project_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS tenant_backup_retention ON core.tenant_backup (retention_until) WHERE verified_at IS NULL;

-- Deny mutations on backup rows.
CREATE OR REPLACE FUNCTION core.deny_mutation_tenant_backup()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'tenant_backup is append-only; % denied', TG_OP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tenant_backup_immutable
  BEFORE UPDATE OR DELETE ON core.tenant_backup
  FOR EACH ROW EXECUTE FUNCTION core.deny_mutation_tenant_backup();

COMMENT ON TABLE core.tenant_backup IS
  'Backup catalog. Append-only. Each row references a logical or physical backup of a project schema.';

-- ============================================================
-- core.tenant_lifecycle_notify — event notification
-- Emits pg_notify for every state transition (limited payload).
-- ============================================================
CREATE OR REPLACE FUNCTION core.notify_tenant_lifecycle_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'tenant_lifecycle_changed',
    json_build_object(
      'project_id', NEW.project_id,
      'to_state',   NEW.to_state,
      'event_id',   NEW.event_id
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tenant_lifecycle_event_notify
  AFTER INSERT ON core.tenant_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION core.notify_tenant_lifecycle_change();

-- ============================================================
-- core.tenant_lifecycle_guard — guard state transitions
-- Enforces valid state machine paths.
-- ============================================================
CREATE OR REPLACE FUNCTION core.validate_tenant_lifecycle_transition(
  p_project_id      BIGINT,
  p_from_state      TEXT,
  p_to_state        TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_valid BOOLEAN;
BEGIN
  -- Valid transitions per P893 state machine:
  v_valid := (
    (p_from_state = 'requested'   AND p_to_state = 'provisioning') OR
    (p_from_state = 'provisioning' AND p_to_state = 'active')      OR
    (p_from_state = 'provisioning' AND p_to_state = 'failed')      OR
    (p_from_state = 'active'       AND p_to_state = 'archived')    OR
    (p_from_state = 'active'       AND p_to_state = 'upgrading')   OR
    (p_from_state = 'upgrading'    AND p_to_state = 'active')      OR
    (p_from_state = 'upgrading'    AND p_to_state = 'failed')      OR
    (p_from_state = 'archived'     AND p_to_state = 'active')      OR
    (p_from_state = 'archived'     AND p_to_state = 'retiring')    OR
    (p_from_state = 'retiring'     AND p_to_state = 'retired')     OR
    (p_from_state = 'failed'       AND p_to_state = 'provisioning') -- re-provision idempotence
  );
  RETURN v_valid;
END;
$$;

-- ============================================================
-- core.tenant_lifecycle_transition — state machine transaction
-- Safe state transition with event logging.
-- ============================================================
CREATE OR REPLACE FUNCTION core.tenant_lifecycle_transition(
  p_project_id      BIGINT,
  p_to_state        TEXT,
  p_state_reason    TEXT DEFAULT NULL,
  p_triggered_by_did TEXT DEFAULT 'system',
  p_context         JSONB DEFAULT '{}'
)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_from_state TEXT;
  v_event_id   BIGINT;
BEGIN
  -- Acquire advisory lock to prevent concurrent state transitions on the same project.
  PERFORM pg_advisory_xact_lock(p_project_id);

  -- Get current state.
  SELECT state INTO v_from_state
    FROM core.tenant_lifecycle
   WHERE project_id = p_project_id;

  IF v_from_state IS NULL THEN
    RAISE EXCEPTION 'tenant_lifecycle row does not exist for project_id %', p_project_id;
  END IF;

  -- Validate transition.
  IF NOT core.validate_tenant_lifecycle_transition(p_project_id, v_from_state, p_to_state) THEN
    RAISE EXCEPTION 'Invalid transition: % → %', v_from_state, p_to_state;
  END IF;

  -- Update state.
  UPDATE core.tenant_lifecycle
     SET state = p_to_state,
         state_reason = p_state_reason,
         state_changed_at = now(),
         updated_at = now()
   WHERE project_id = p_project_id;

  -- Log event.
  INSERT INTO core.tenant_lifecycle_event
    (project_id, from_state, to_state, triggered_by_did, context)
  VALUES
    (p_project_id, v_from_state, p_to_state, p_triggered_by_did, p_context)
  RETURNING event_id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION core.tenant_lifecycle_transition IS
  'Atomically transition project schema state and log event. Acquires pg_advisory_xact_lock(project_id).';

-- ============================================================
-- core.tenant_lifecycle_initialize — bootstrap a new tenant
-- ============================================================
CREATE OR REPLACE FUNCTION core.tenant_lifecycle_initialize(
  p_project_id      BIGINT,
  p_owner_did       TEXT,
  p_backup_policy   JSONB DEFAULT NULL,
  p_resource_quota  JSONB DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_backup_policy  JSONB;
  v_resource_quota JSONB;
BEGIN
  v_backup_policy := COALESCE(p_backup_policy,
    '{"schedule": "0 2 * * 0", "retention_days": 30, "target": "file:///var/lib/agentHive/backups"}');
  v_resource_quota := COALESCE(p_resource_quota,
    '{"max_connections": 100, "max_schema_size_gb": 50, "statement_timeout_ms": 300000}');

  INSERT INTO core.tenant_lifecycle
    (project_id, state, ddl_version, backup_policy, resource_quota, owner_did)
  VALUES
    (p_project_id, 'requested', 1, v_backup_policy, v_resource_quota, p_owner_did)
  ON CONFLICT (project_id) DO UPDATE
    SET state = 'requested',
        ddl_version = 1,
        backup_policy = v_backup_policy,
        resource_quota = v_resource_quota,
        owner_did = p_owner_did,
        updated_at = now();
END;
$$;

COMMENT ON FUNCTION core.tenant_lifecycle_initialize IS
  'Initialize a new tenant_lifecycle row in "requested" state.';

-- ============================================================
-- Deny direct mutations on tenant_lifecycle rows
-- ============================================================
CREATE OR REPLACE FUNCTION core.deny_direct_tenant_lifecycle_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Allow only state machine function to mutate this table.
  RAISE EXCEPTION
    'Direct updates to tenant_lifecycle are forbidden. Use core.tenant_lifecycle_transition().';
END;
$$;

CREATE OR REPLACE TRIGGER tenant_lifecycle_enforce_transition_fn
  BEFORE UPDATE ON core.tenant_lifecycle
  FOR EACH ROW
  WHEN (pg_current_xact_id() != (
    SELECT pg_current_xact_id() FROM core.tenant_lifecycle_event
    WHERE project_id = NEW.project_id
    ORDER BY event_id DESC LIMIT 1
  ))
  EXECUTE FUNCTION core.deny_direct_tenant_lifecycle_mutation();

-- Note: The trigger above is a best-effort guard. In production, enforce via
-- application code only and revoke direct UPDATE/DELETE privileges from services.
-- For now, we rely on procedural discipline.

COMMENT ON SCHEMA core IS
  'UPDATED: Foundation layer with tenant lifecycle state machine (P893).';

-- ============================================================
-- Verify tables created
-- ============================================================
SELECT
  'tenant_lifecycle' as table_name,
  COUNT(*) as row_count
FROM core.tenant_lifecycle
UNION ALL
SELECT
  'tenant_lifecycle_event' as table_name,
  COUNT(*) as row_count
FROM core.tenant_lifecycle_event
UNION ALL
SELECT
  'tenant_backup' as table_name,
  COUNT(*) as row_count
FROM core.tenant_backup;
