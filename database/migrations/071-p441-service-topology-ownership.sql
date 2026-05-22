-- P441: Service Topology Ownership — one owner per state-machine responsibility
--
-- Creates the control_runtime schema with service_registry, service_responsibility,
-- and service_lease tables, plus fn_enforce_service_ownership() triggers on all
-- governed tables. Enforcement is opt-in via SET LOCAL app.service_id; services
-- that leave it unset pass through transparently (migration boundary).
--
-- Governed tables:
--   roadmap_proposal.proposal        BEFORE UPDATE OF status    → state_machine_transition
--   roadmap_proposal.proposal        BEFORE UPDATE OF maturity  → maturity_sync
--   roadmap_proposal.transition_queue BEFORE INSERT             → state_machine_transition
--   roadmap.decision_queue           BEFORE INSERT OR UPDATE    → gate_evaluation
--   roadmap_workforce.squad_dispatch BEFORE INSERT OR UPDATE    → work_offer_claim
--   control_runtime.service_lease    BEFORE INSERT OR UPDATE    → service_lease_management

BEGIN;

-- ─── Schema ────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS control_runtime;

-- ─── service_registry ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_runtime.service_registry (
    service_id      TEXT        PRIMARY KEY,
    service_type    TEXT        NOT NULL,
    host            TEXT        NOT NULL DEFAULT '',
    pid             INTEGER,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE control_runtime.service_registry IS
'One row per running service instance. Heartbeat updated periodically so the
orchestrator can detect stale services. On restart the service upserts its row.';

-- ─── service_responsibility ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_runtime.service_responsibility (
    id              BIGSERIAL   PRIMARY KEY,
    service_id      TEXT        NOT NULL
                        REFERENCES control_runtime.service_registry(service_id)
                        ON DELETE CASCADE,
    responsibility  TEXT        NOT NULL,
    mode            TEXT        NOT NULL DEFAULT 'primary'
                        CONSTRAINT service_responsibility_mode_check
                        CHECK (mode IN ('primary', 'passive')),
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE control_runtime.service_responsibility IS
'Declares which service owns (primary) or observes (passive) each responsibility.
The partial unique index below enforces that at most one primary exists per
responsibility at any time.';

-- Only one primary per responsibility allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_responsibility_one_primary
    ON control_runtime.service_responsibility (responsibility)
    WHERE mode = 'primary';

CREATE INDEX IF NOT EXISTS idx_service_responsibility_service
    ON control_runtime.service_responsibility (service_id);

-- ─── service_lease ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_runtime.service_lease (
    lease_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      TEXT        NOT NULL
                        REFERENCES control_runtime.service_registry(service_id)
                        ON DELETE CASCADE,
    responsibility  TEXT        NOT NULL,
    acquired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    released_at     TIMESTAMPTZ,
    release_reason  TEXT,
    CONSTRAINT service_lease_expires_after_acquired
        CHECK (expires_at > acquired_at)
);

COMMENT ON TABLE control_runtime.service_lease IS
'Time-bounded lease proving a service currently holds a responsibility.
The partial unique index enforces at most one active (unreleased) lease per
responsibility. Released rows are kept as audit history.';

-- At most one active (unreleased) lease per responsibility.
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_lease_active_per_responsibility
    ON control_runtime.service_lease (responsibility)
    WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_lease_service_active
    ON control_runtime.service_lease (service_id)
    WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_lease_expires
    ON control_runtime.service_lease (expires_at)
    WHERE released_at IS NULL;

-- ─── Enforcement trigger function ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION control_runtime.fn_enforce_service_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_service_id    TEXT;
    v_responsibility TEXT;
    v_table_name    TEXT;
    v_active_lease  BOOLEAN;
BEGIN
    -- Backward-compatible pass-through: if app.service_id is not set, skip enforcement.
    BEGIN
        v_service_id := current_setting('app.service_id', true);
    EXCEPTION WHEN OTHERS THEN
        v_service_id := NULL;
    END;

    IF v_service_id IS NULL OR v_service_id = '' THEN
        RETURN NEW;
    END IF;

    -- The responsibility expected for this trigger is passed via TG_ARGV[0].
    v_responsibility := TG_ARGV[0];
    v_table_name     := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;

    -- Verify that an active, non-expired lease exists for this (service, responsibility).
    SELECT EXISTS (
        SELECT 1
        FROM control_runtime.service_lease
        WHERE service_id     = v_service_id
          AND responsibility = v_responsibility
          AND released_at IS NULL
          AND expires_at > now()
    ) INTO v_active_lease;

    IF NOT v_active_lease THEN
        RAISE EXCEPTION
            'Service % lacks an active lease for responsibility %; cannot write %',
            v_service_id, v_responsibility, v_table_name
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION control_runtime.fn_enforce_service_ownership() IS
'Trigger function enforcing single-writer ownership. Called with TG_ARGV[0] = responsibility.
Passes through transparently when app.service_id session variable is not set (migration
boundary). Raises SQLSTATE 42501 (insufficient_privilege) if the caller lacks an active lease.';

-- ─── Triggers on governed tables ──────────────────────────────────────────────

-- roadmap_proposal.proposal: status updates → state_machine_transition
DROP TRIGGER IF EXISTS trg_svc_own_proposal_status ON roadmap_proposal.proposal;
CREATE TRIGGER trg_svc_own_proposal_status
    BEFORE UPDATE OF status ON roadmap_proposal.proposal
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('state_machine_transition');

-- roadmap_proposal.proposal: maturity updates → maturity_sync
DROP TRIGGER IF EXISTS trg_svc_own_proposal_maturity ON roadmap_proposal.proposal;
CREATE TRIGGER trg_svc_own_proposal_maturity
    BEFORE UPDATE OF maturity ON roadmap_proposal.proposal
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('maturity_sync');

-- roadmap_proposal.transition_queue: inserts → state_machine_transition
DROP TRIGGER IF EXISTS trg_svc_own_transition_queue ON roadmap_proposal.transition_queue;
CREATE TRIGGER trg_svc_own_transition_queue
    BEFORE INSERT ON roadmap_proposal.transition_queue
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('state_machine_transition');

-- roadmap.decision_queue: inserts/updates → gate_evaluation
DROP TRIGGER IF EXISTS trg_svc_own_decision_queue ON roadmap.decision_queue;
CREATE TRIGGER trg_svc_own_decision_queue
    BEFORE INSERT OR UPDATE ON roadmap.decision_queue
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('gate_evaluation');

-- roadmap_workforce.squad_dispatch: inserts/updates → work_offer_claim
DROP TRIGGER IF EXISTS trg_svc_own_squad_dispatch ON roadmap_workforce.squad_dispatch;
CREATE TRIGGER trg_svc_own_squad_dispatch
    BEFORE INSERT OR UPDATE ON roadmap_workforce.squad_dispatch
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('work_offer_claim');

-- control_runtime.service_lease: inserts/updates → service_lease_management
DROP TRIGGER IF EXISTS trg_svc_own_service_lease ON control_runtime.service_lease;
CREATE TRIGGER trg_svc_own_service_lease
    BEFORE INSERT OR UPDATE ON control_runtime.service_lease
    FOR EACH ROW
    EXECUTE FUNCTION control_runtime.fn_enforce_service_ownership('service_lease_management');

-- ─── Seed static ownership matrix ─────────────────────────────────────────────
-- Seed service_registry stubs so FK constraints on service_responsibility can
-- reference them. These are informational; real services upsert their own rows.

INSERT INTO control_runtime.service_registry (service_id, service_type, host)
VALUES
    ('orchestrator',       'orchestrator',    ''),
    ('offer-provider',     'offer-provider',  ''),
    ('mcp-server',         'mcp-server',      ''),
    ('state-feed-listener','feed-listener',   '')
ON CONFLICT (service_id) DO NOTHING;

INSERT INTO control_runtime.service_responsibility (service_id, responsibility, mode)
VALUES
    -- Primary writers
    ('orchestrator',        'state_machine_transition', 'primary'),
    ('orchestrator',        'maturity_sync',            'primary'),
    ('orchestrator',        'workflow_spawn',           'primary'),
    ('orchestrator',        'service_lease_management', 'primary'),
    ('orchestrator',        'gate_evaluation',          'primary'),
    ('offer-provider',      'work_offer_claim',         'primary'),
    ('offer-provider',      'subprocess_spawn',         'primary'),
    ('mcp-server',          'proposal_crud',            'primary'),
    ('state-feed-listener', 'feed_event_publication',   'primary'),
    -- Passive observers
    ('mcp-server',          'state_machine_transition', 'passive'),
    ('state-feed-listener', 'state_machine_transition', 'passive'),
    ('mcp-server',          'work_offer_claim',         'passive')
ON CONFLICT DO NOTHING;

COMMIT;
