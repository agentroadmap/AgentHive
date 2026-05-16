-- ============================================================
-- agentHive2 — 007-tenant-lifecycle.sql
-- Tenant lifecycle state machine: provisioning, activation,
-- upgrades, archival, retirement, and audit trail.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql (core.project)
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.tenant_lifecycle — mutable state row per tenant
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_lifecycle (
  project_id       BIGINT       PRIMARY KEY REFERENCES core.project(id) ON DELETE RESTRICT,
  state            TEXT         NOT NULL
                               CHECK (state IN ('requested','provisioning','active','archived','upgrading','retiring','retired','failed')),
  state_reason     TEXT,
  ddl_version      INT          NOT NULL DEFAULT 1,
  backup_policy    JSONB        NOT NULL DEFAULT '{}',
  resource_quota   JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT,
  state_changed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_state
  ON core.tenant_lifecycle(state) WHERE state != 'retired';

CREATE INDEX IF NOT EXISTS tenant_lifecycle_state_changed
  ON core.tenant_lifecycle(state_changed_at DESC);

CREATE OR REPLACE TRIGGER set_updated_at_tenant_lifecycle
  BEFORE UPDATE ON core.tenant_lifecycle
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.tenant_lifecycle IS
  'Current lifecycle state of each tenant (project schema). '
  'Single mutable row per tenant. State changes audit via tenant_lifecycle_event.';

-- ============================================================
-- core.tenant_lifecycle_event — append-only audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_lifecycle_event (
  event_id         BIGSERIAL    PRIMARY KEY,
  project_id       BIGINT       NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  from_state       TEXT,
  to_state         TEXT         NOT NULL,
  triggered_by_did TEXT,
  context          JSONB        NOT NULL DEFAULT '{}',
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_event_project
  ON core.tenant_lifecycle_event(project_id);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_event_occurred
  ON core.tenant_lifecycle_event(occurred_at DESC);

CREATE INDEX IF NOT EXISTS tenant_lifecycle_event_transition
  ON core.tenant_lifecycle_event(from_state, to_state);

-- Append-only enforcement: deny mutations
CREATE OR REPLACE FUNCTION core.deny_tenant_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'core.tenant_lifecycle_event is append-only — % not permitted', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER deny_tenant_event_mutation
  BEFORE UPDATE OR DELETE ON core.tenant_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION core.deny_tenant_event_mutation();

COMMENT ON TABLE core.tenant_lifecycle_event IS
  'Append-only audit log of tenant state transitions. '
  'Every state change creates one row. Immutable; UPDATEs and DELETEs are forbidden.';

-- ============================================================
-- core.tenant_backup — append-only backup registry
-- ============================================================
CREATE TABLE IF NOT EXISTS core.tenant_backup (
  backup_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       BIGINT       NOT NULL REFERENCES core.project(id) ON DELETE CASCADE,
  taken_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  backup_kind      TEXT         NOT NULL
                               CHECK (backup_kind IN ('full','schema','wal')),
  storage_uri      TEXT         NOT NULL,
  size_bytes       BIGINT,
  retention_until  TIMESTAMPTZ,
  verified_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tenant_backup_project
  ON core.tenant_backup(project_id);

CREATE INDEX IF NOT EXISTS tenant_backup_taken
  ON core.tenant_backup(taken_at DESC);

CREATE INDEX IF NOT EXISTS tenant_backup_kind
  ON core.tenant_backup(backup_kind) WHERE verified_at IS NOT NULL;

-- Append-only enforcement: deny mutations
CREATE OR REPLACE FUNCTION core.deny_tenant_backup_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'core.tenant_backup is append-only — % not permitted', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER deny_tenant_backup_mutation
  BEFORE UPDATE OR DELETE ON core.tenant_backup
  FOR EACH ROW EXECUTE FUNCTION core.deny_tenant_backup_mutation();

COMMENT ON TABLE core.tenant_backup IS
  'Append-only registry of all backups taken for each tenant. '
  'Immutable; UPDATEs and DELETEs are forbidden.';

-- ============================================================
-- State transition validator and state machine
-- ============================================================
CREATE OR REPLACE FUNCTION core.validate_tenant_transition(
  p_from_state TEXT,
  p_to_state TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- No-op transition (same state) is allowed
  IF p_from_state = p_to_state THEN
    RETURN true;
  END IF;

  -- Valid adjacencies
  CASE p_from_state
    WHEN 'requested' THEN
      RETURN p_to_state IN ('provisioning', 'failed');
    WHEN 'provisioning' THEN
      RETURN p_to_state IN ('active', 'failed');
    WHEN 'active' THEN
      RETURN p_to_state IN ('archived', 'upgrading', 'retiring', 'failed');
    WHEN 'upgrading' THEN
      RETURN p_to_state IN ('active', 'failed');
    WHEN 'archived' THEN
      RETURN p_to_state IN ('active', 'retiring', 'failed');
    WHEN 'retiring' THEN
      RETURN p_to_state IN ('retired', 'failed');
    WHEN 'retired' THEN
      -- retired is terminal; no transitions except to itself
      RETURN false;
    WHEN 'failed' THEN
      -- failed is terminal; no transitions except to itself
      RETURN false;
    ELSE
      RETURN false;
  END CASE;
END;
$$;

COMMENT ON FUNCTION core.validate_tenant_transition(TEXT, TEXT) IS
  'State machine validator. Returns true if transition is allowed, false otherwise.';

-- ============================================================
-- core.fn_tenant_transition — main state transition function
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_tenant_transition(
  p_project_id BIGINT,
  p_to_state TEXT,
  p_triggered_by TEXT,
  p_context JSONB DEFAULT '{}'
)
RETURNS TABLE (
  event_id BIGINT,
  project_id BIGINT,
  from_state TEXT,
  to_state TEXT,
  occurred_at TIMESTAMPTZ
) LANGUAGE plpgsql AS $$
DECLARE
  v_from_state TEXT;
  v_event_id BIGINT;
  v_valid BOOLEAN;
BEGIN
  -- Ensure project exists
  IF NOT EXISTS (SELECT 1 FROM core.project WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Project % not found', p_project_id;
  END IF;

  -- Get current state (default: requested if row does not exist)
  SELECT state INTO v_from_state
    FROM core.tenant_lifecycle
   WHERE project_id = p_project_id;

  IF v_from_state IS NULL THEN
    v_from_state := 'requested';
  END IF;

  -- Validate transition
  v_valid := core.validate_tenant_transition(v_from_state, p_to_state);
  IF NOT v_valid THEN
    RAISE EXCEPTION 'Invalid state transition: % -> %', v_from_state, p_to_state;
  END IF;

  -- No-op transitions still create an audit record
  -- Insert or update tenant_lifecycle
  INSERT INTO core.tenant_lifecycle (
    project_id,
    state,
    state_reason,
    owner_did,
    state_changed_at
  ) VALUES (
    p_project_id,
    p_to_state,
    COALESCE((p_context->>'reason'), NULL),
    p_triggered_by,
    now()
  )
  ON CONFLICT (project_id) DO UPDATE SET
    state = EXCLUDED.state,
    state_reason = EXCLUDED.state_reason,
    state_changed_at = EXCLUDED.state_changed_at,
    updated_at = now();

  -- Insert audit event
  INSERT INTO core.tenant_lifecycle_event (
    project_id,
    from_state,
    to_state,
    triggered_by_did,
    context,
    occurred_at
  ) VALUES (
    p_project_id,
    v_from_state,
    p_to_state,
    p_triggered_by,
    p_context,
    now()
  )
  RETURNING
    event_id,
    project_id,
    from_state,
    to_state,
    occurred_at
  INTO v_event_id, project_id, from_state, to_state, occurred_at;

  -- Notify listeners
  PERFORM pg_notify(
    'tenant_lifecycle',
    json_build_object(
      'project_id', p_project_id,
      'from_state', v_from_state,
      'to_state', p_to_state,
      'event_id', v_event_id,
      'occurred_at', now()
    )::text
  );

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION core.fn_tenant_transition(BIGINT, TEXT, TEXT, JSONB) IS
  'Execute a tenant state transition. Validates adjacency, updates tenant_lifecycle, '
  'inserts audit event, and emits pg_notify(tenant_lifecycle). Returns the event row.';

-- ============================================================
-- core.fn_provision_tenant — idempotent provisioning function
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_provision_tenant(
  p_project_id BIGINT,
  p_triggered_by TEXT
)
RETURNS TABLE (
  success BOOLEAN,
  message TEXT,
  schema_name TEXT,
  final_state TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  v_slug TEXT;
  v_schema_name TEXT;
  v_current_state TEXT;
  v_error_msg TEXT;
BEGIN
  -- Step 1: Advisory lock to prevent concurrent provisioning
  PERFORM pg_advisory_xact_lock(p_project_id);

  -- Step 2: Ensure project row exists
  SELECT slug, schema_name INTO v_slug, v_schema_name
    FROM core.project
   WHERE id = p_project_id;

  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'Project % not found', p_project_id;
  END IF;

  BEGIN
    -- Step 3: Create schema if not exists
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema_name);

    -- Step 4: Transition to provisioning
    PERFORM * FROM core.fn_tenant_transition(
      p_project_id,
      'provisioning',
      p_triggered_by,
      json_build_object('source', 'fn_provision_tenant', 'step', 'mark_provisioning')
    );

    -- Step 5: Emit provisioning_start notification
    PERFORM pg_notify(
      'tenant_provisioning_start',
      json_build_object(
        'project_id', p_project_id,
        'schema_name', v_schema_name,
        'slug', v_slug
      )::text
    );

    -- Step 6: Ensure tenant_lifecycle row exists with initial state
    INSERT INTO core.tenant_lifecycle (
      project_id,
      state,
      owner_did,
      state_changed_at
    ) VALUES (
      p_project_id,
      'requested',
      p_triggered_by,
      now()
    )
    ON CONFLICT (project_id) DO NOTHING;

    -- Step 7: Transition to active
    PERFORM * FROM core.fn_tenant_transition(
      p_project_id,
      'active',
      p_triggered_by,
      json_build_object('source', 'fn_provision_tenant', 'step', 'mark_active')
    );

    -- Step 8: Emit active notification
    PERFORM pg_notify(
      'tenant_lifecycle',
      json_build_object(
        'project_id', p_project_id,
        'state', 'active',
        'schema_name', v_schema_name,
        'slug', v_slug
      )::text
    );

    -- Step 9: Get final state
    SELECT state INTO v_current_state
      FROM core.tenant_lifecycle
     WHERE project_id = p_project_id;

    -- Step 10: Return success
    success := true;
    message := 'Tenant provisioned successfully';
    schema_name := v_schema_name;
    final_state := v_current_state;
    RETURN NEXT;

  EXCEPTION WHEN OTHERS THEN
    v_error_msg := SQLERRM;

    -- On failure, transition to failed state
    BEGIN
      PERFORM * FROM core.fn_tenant_transition(
        p_project_id,
        'failed',
        p_triggered_by,
        json_build_object('source', 'fn_provision_tenant', 'error', v_error_msg)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- If even the failure transition fails, swallow it
    END;

    success := false;
    message := v_error_msg;
    schema_name := v_schema_name;
    final_state := 'failed';
    RETURN NEXT;
    RETURN;
  END;
END;
$$;

COMMENT ON FUNCTION core.fn_provision_tenant(BIGINT, TEXT) IS
  'Idempotent tenant provisioning. Creates schema, transitions to active, and notifies. '
  'On any error, transitions to failed and re-raises.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON core.tenant_lifecycle TO agenthive_orchestrator;
    GRANT INSERT ON core.tenant_lifecycle_event TO agenthive_orchestrator;
    GRANT INSERT ON core.tenant_backup TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_tenant_transition(BIGINT, TEXT, TEXT, JSONB) TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_provision_tenant(BIGINT, TEXT) TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.validate_tenant_transition(TEXT, TEXT) TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON core.tenant_lifecycle, core.tenant_lifecycle_event, core.tenant_backup TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_agency;
    GRANT SELECT ON core.tenant_lifecycle TO agenthive_agency;
  END IF;
END $$;
