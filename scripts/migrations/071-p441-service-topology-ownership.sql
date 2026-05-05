-- ============================================================
-- Migration 071 — P441: Service Topology Ownership
-- One declared primary writer per state-machine responsibility.
-- ============================================================
-- Applies:
--   1. control_runtime schema
--   2. service_registry — running service identity + heartbeat
--   3. service_responsibility — declared ownership per responsibility
--      UNIQUE partial index: one primary per responsibility (single-writer invariant)
--   4. service_lease — active write leases
--      UNIQUE partial index: one active lease per responsibility
--   5. fn_enforce_service_ownership() — generic trigger function
--   6. Triggers on governed tables
--      Backward-compat: NULL/empty app.service_id → pass-through
-- ============================================================

BEGIN;

-- ============================================================
-- 1. control_runtime schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS control_runtime;

COMMENT ON SCHEMA control_runtime IS
  'Runtime-control tables: service registry, responsibility ownership, '
  'and active service leases. Used by P441 enforcement triggers.';

-- ============================================================
-- 2. service_registry — identity + heartbeat
-- ============================================================
CREATE TABLE IF NOT EXISTS control_runtime.service_registry (
  service_id     TEXT        PRIMARY KEY,
  service_type   TEXT        NOT NULL,
  host           TEXT        NOT NULL DEFAULT 'localhost',
  pid            INT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE control_runtime.service_registry IS
  'One row per live service instance. '
  'Heartbeat is updated by the service on a regular interval to signal liveness.';

-- ============================================================
-- 3. service_responsibility — declared ownership boundaries
-- ============================================================
CREATE TABLE IF NOT EXISTS control_runtime.service_responsibility (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id     TEXT   NOT NULL
                        REFERENCES control_runtime.service_registry(service_id)
                        ON DELETE CASCADE,
  responsibility TEXT   NOT NULL,
  mode           TEXT   NOT NULL DEFAULT 'primary'
                        CHECK (mode IN ('primary', 'passive'))
);

COMMENT ON TABLE control_runtime.service_responsibility IS
  'Declared ownership per responsibility. '
  'mode=primary: single authoritative writer enforced by trigger. '
  'mode=passive: read-only consumer, cannot mutate governed tables for this responsibility.';

-- Single-writer invariant: only one primary per responsibility
CREATE UNIQUE INDEX IF NOT EXISTS idx_svc_resp_one_primary
  ON control_runtime.service_responsibility (responsibility)
  WHERE mode = 'primary';

CREATE INDEX IF NOT EXISTS idx_svc_resp_service
  ON control_runtime.service_responsibility (service_id);

-- ============================================================
-- 4. service_lease — active write leases
-- ============================================================
CREATE TABLE IF NOT EXISTS control_runtime.service_lease (
  lease_id       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  service_id     TEXT        NOT NULL
                             REFERENCES control_runtime.service_registry(service_id)
                             ON DELETE CASCADE,
  responsibility TEXT        NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  released_at    TIMESTAMPTZ,
  release_reason TEXT
);

COMMENT ON TABLE control_runtime.service_lease IS
  'Active write leases. A service must hold a non-expired, non-released lease '
  'for a responsibility before DB triggers permit mutations on governed tables. '
  'The UNIQUE partial index prevents two concurrent active leases for the same responsibility.';

-- One active lease per responsibility at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_svc_lease_one_active
  ON control_runtime.service_lease (responsibility)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_svc_lease_service
  ON control_runtime.service_lease (service_id, released_at);

CREATE INDEX IF NOT EXISTS idx_svc_lease_expiry
  ON control_runtime.service_lease (expires_at)
  WHERE released_at IS NULL;

-- ============================================================
-- 5. fn_enforce_service_ownership
-- Row-level trigger function for all governed tables.
-- Usage: EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('responsibility_name')
-- ============================================================
CREATE OR REPLACE FUNCTION control_runtime.fn_enforce_service_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = control_runtime, pg_catalog
AS $$
DECLARE
  v_service_id    TEXT;
  v_required_resp TEXT := TG_ARGV[0];
BEGIN
  v_service_id := current_setting('app.service_id', true);

  -- Backward-compatible pass-through: if no service context is set,
  -- allow the write. Services not yet updated bypass enforcement.
  -- Migration boundary: set app.service_id only after bootstrapping leases.
  IF v_service_id IS NULL OR v_service_id = '' THEN
    RETURN NEW;
  END IF;

  -- Service must hold an active, non-expired lease for this responsibility.
  IF NOT EXISTS (
    SELECT 1
    FROM   control_runtime.service_lease sl
    WHERE  sl.service_id     = v_service_id
      AND  sl.responsibility = v_required_resp
      AND  sl.released_at    IS NULL
      AND  sl.expires_at     > now()
  ) THEN
    RAISE EXCEPTION
      'Service % lacks an active lease for responsibility %; cannot write %.%',
      v_service_id, v_required_resp, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION control_runtime.fn_enforce_service_ownership() IS
  'Row-level trigger function enforcing single-writer ownership. '
  'Reads app.service_id session var; skips if unset (backward compat). '
  'Raises insufficient_privilege if service lacks an active lease.';

-- ============================================================
-- 6. Triggers on governed tables
-- ============================================================

-- 6a. roadmap.proposal status → state_machine_transition
DROP TRIGGER IF EXISTS trg_svc_own_proposal_status
  ON roadmap.proposal;
CREATE TRIGGER trg_svc_own_proposal_status
  BEFORE UPDATE OF status
  ON roadmap.proposal
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('state_machine_transition');

-- 6b. roadmap.proposal maturity → maturity_sync
DROP TRIGGER IF EXISTS trg_svc_own_proposal_maturity
  ON roadmap.proposal;
CREATE TRIGGER trg_svc_own_proposal_maturity
  BEFORE UPDATE OF maturity
  ON roadmap.proposal
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('maturity_sync');

-- 6c. roadmap.transition_queue INSERT → state_machine_transition
DROP TRIGGER IF EXISTS trg_svc_own_transition_queue
  ON roadmap.transition_queue;
CREATE TRIGGER trg_svc_own_transition_queue
  BEFORE INSERT
  ON roadmap.transition_queue
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('state_machine_transition');

-- 6d. roadmap.decision_queue INSERT/UPDATE → gate_evaluation
DROP TRIGGER IF EXISTS trg_svc_own_decision_queue
  ON roadmap.decision_queue;
CREATE TRIGGER trg_svc_own_decision_queue
  BEFORE INSERT OR UPDATE
  ON roadmap.decision_queue
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('gate_evaluation');

-- 6e. roadmap_workforce.squad_dispatch INSERT/UPDATE → work_offer_claim
DROP TRIGGER IF EXISTS trg_svc_own_squad_dispatch
  ON roadmap_workforce.squad_dispatch;
CREATE TRIGGER trg_svc_own_squad_dispatch
  BEFORE INSERT OR UPDATE
  ON roadmap_workforce.squad_dispatch
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('work_offer_claim');

-- 6f. control_runtime.service_lease INSERT/UPDATE → service_lease_management
-- Note: bootstrapping (first lease acquisition) works because the backward-compat
-- pass-through fires when app.service_id is unset.
DROP TRIGGER IF EXISTS trg_svc_own_service_lease
  ON control_runtime.service_lease;
CREATE TRIGGER trg_svc_own_service_lease
  BEFORE INSERT OR UPDATE
  ON control_runtime.service_lease
  FOR EACH ROW
  EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('service_lease_management');

COMMIT;
