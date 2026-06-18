-- ============================================================
-- P820 AC-1/2/3/4 — dispatch schema: full queue DDL
-- Tables: work_offer, proposal_lease, dispatch_audit, capacity_snapshot
-- Plus: extends existing dispatch.work_claim (from 005-dispatch-stub.sql)
-- ============================================================
-- Target DB:  hiveCentral
-- Owner:      agenthive_admin
-- Schema:     dispatch
-- Depends on: 001-core.sql (core.*), 003-agency.sql (agency.agency),
--             004-model.sql (hivecentral.model_route)
-- Min PG:     16
--
-- NOTE: 005-dispatch-stub.sql created the dispatch schema and
-- dispatch.work_claim (billing-snapshot claim record). This file adds the
-- remaining queue tables and must be applied AFTER the stub.
--
-- DESIGN DECISION — proposal family (AC-1 resolution):
--   Option A: proposals stay in the tenant DB (roadmap.proposal), referenced
--   from hiveCentral only by application-level FK (proposal_id BIGINT).
--   Postgres cannot enforce cross-DB FKs; audit queries are the guard.
--   Rationale: proposal data is tenant-specific (per DESIGN Principle 2 —
--   "no tenant application data in hiveCentral"). A thin cross-tenant index
--   (Option B) would violate this invariant by copying proposal-scoped data
--   into the control plane. Option A is adopted; all proposal_id columns in
--   this file are documented as application-level invariants.
--
-- DESIGN DECISION — runtime family (AC-1 resolution):
--   The 17th schema family "runtime" is subsumed by core. core.runtime_flag
--   covers the runtime feature-flag/config surface; core.service_heartbeat
--   covers service liveness. No separate runtime schema is created. The AC-1
--   count of 17 maps: runtime → core (absorbed), queue → dispatch (renamed).
--   The README schema count of 15 should be updated to note this.
-- ============================================================

\set ON_ERROR_STOP on

-- dispatch schema is already created by 005-dispatch-stub.sql.
-- Idempotent guard in case this file is applied before the stub (rare).
CREATE SCHEMA IF NOT EXISTS dispatch;

COMMENT ON SCHEMA dispatch IS
  'Queue and leasing layer for the orchestrator. Covers work offers '
  '(orchestrator→agency), active leases, immutable audit trail, and '
  'point-in-time capacity snapshots for dispatch-decision debugging.';

-- ============================================================
-- Shared trigger: set_updated_at (mirrors core pattern)
-- ============================================================
CREATE OR REPLACE FUNCTION dispatch.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ============================================================
-- dispatch.work_offer — pre-claim offers from orchestrator to agency
-- ============================================================
-- State machine (TEXT+CHECK, no PG ENUM — additive changes require only
-- ALTER TABLE ... ALTER CONSTRAINT, not a full ENUM type migration):
--
--   pending  → claimed   (agency called claim_work_offer; creates/extends lease)
--   pending  → expired   (expires_at elapsed without claim; reaped by orchestrator)
--   pending  → retracted (orchestrator cancelled before claim)
--   claimed  → released  (lease released by agency or TTL expiry)
--   expired  → (terminal)
--   retracted → (terminal)
--   released → (terminal)
--
-- proposal_id is a cross-DB application-level FK to tenant_db.roadmap.proposal.id.
-- Audit query: SELECT o.id, o.proposal_id FROM dispatch.work_offer o
--              LEFT JOIN dispatch.proposal_lease l ON l.offer_id = o.id
--              WHERE o.state = 'claimed' AND l.lease_id IS NULL  → orphaned offers.
CREATE TABLE IF NOT EXISTS dispatch.work_offer (
  offer_id         BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL,           -- app-FK → tenant_db.roadmap.proposal.id
  agency_id        TEXT         REFERENCES agency.agency(agency_id) ON DELETE SET NULL,
  route_id         BIGINT       REFERENCES hivecentral.model_route(id) ON DELETE SET NULL,
  role             TEXT         NOT NULL,            -- 'enrichment_agent' | 'gate_agent' | …
  priority         INT          NOT NULL DEFAULT 50
                                CHECK (priority BETWEEN 1 AND 100),
  state            TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending','claimed','expired','retracted','released')),
  tenant_db_slug   TEXT         NOT NULL,            -- identifies which tenant DB owns proposal_id
  input_payload    JSONB        NOT NULL DEFAULT '{}', -- enriched offer context passed to agency
  cost_snapshot    JSONB        NOT NULL DEFAULT '{}', -- route pricing snapped at offer time
  expires_at       TIMESTAMPTZ  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  retracted_at     TIMESTAMPTZ,
  retract_reason   TEXT,

  -- Invariant: retracted_at and retract_reason are only set when state='retracted'
  CONSTRAINT retract_consistent CHECK (
    (state = 'retracted' AND retracted_at IS NOT NULL AND retract_reason IS NOT NULL) OR
    (state <> 'retracted' AND retracted_at IS NULL)
  )
);

-- Orchestrator primary query: poll pending offers ordered by priority
CREATE INDEX IF NOT EXISTS work_offer_pending_priority
  ON dispatch.work_offer (priority DESC, created_at)
  WHERE state = 'pending';

-- Agency query: what offers are pending for me?
CREATE INDEX IF NOT EXISTS work_offer_agency_pending
  ON dispatch.work_offer (agency_id, priority DESC)
  WHERE state = 'pending';

-- TTL reaper query: find expired-but-still-pending offers
CREATE INDEX IF NOT EXISTS work_offer_expires_pending
  ON dispatch.work_offer (expires_at)
  WHERE state = 'pending';

-- Historical lookup by proposal (cross-DB app-FK join pattern)
CREATE INDEX IF NOT EXISTS work_offer_proposal
  ON dispatch.work_offer (proposal_id, created_at DESC);

CREATE OR REPLACE TRIGGER set_updated_at_work_offer
  BEFORE UPDATE ON dispatch.work_offer
  FOR EACH ROW EXECUTE FUNCTION dispatch.set_updated_at();

COMMENT ON TABLE dispatch.work_offer IS
  'Work offers: orchestrator proposes a job to an agency. Transitions: '
  'pending→claimed (agency accepts), pending→expired (TTL), pending→retracted (orch cancels). '
  'proposal_id is an application-level FK to the tenant DB — Postgres cannot enforce it cross-DB.';

COMMENT ON COLUMN dispatch.work_offer.cost_snapshot IS
  'Route pricing snapped at offer creation time (same shape as dispatch.work_claim.cost_snapshot). '
  'Immutable after INSERT — enforced by trg_work_offer_guard_cost_snapshot trigger.';

COMMENT ON COLUMN dispatch.work_offer.input_payload IS
  'Enriched offer context: AC list, prior discussions, linked proposal summaries. '
  'Passed as spawn context to the agency CLI. Immutable after INSERT.';

-- cost_snapshot immutability guard (mirrors work_claim pattern)
CREATE OR REPLACE FUNCTION dispatch.fn_guard_offer_cost_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cost_snapshot IS DISTINCT FROM OLD.cost_snapshot THEN
    RAISE EXCEPTION
      'dispatch.work_offer.cost_snapshot is immutable after insert (offer_id=%). '
      'Create a new offer instead.',
      OLD.offer_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_offer_guard_cost_snapshot ON dispatch.work_offer;
CREATE TRIGGER trg_work_offer_guard_cost_snapshot
  BEFORE UPDATE ON dispatch.work_offer
  FOR EACH ROW EXECUTE FUNCTION dispatch.fn_guard_offer_cost_snapshot();

-- ============================================================
-- dispatch.proposal_lease — active work leases per proposal
-- ============================================================
-- One active row (is_active=true) per proposal_id at any time (partial unique index).
-- Lifetime: created when offer is claimed → released when agency finishes or TTL expires.
-- The lease_id in the live system corresponds to roadmap.proposal_lease (agenthive DB);
-- this hiveCentral table is the canonical control-plane version used after P501 cutover.
--
-- Application-level invariant: proposal_id references the tenant DB matching tenant_db_slug.
CREATE TABLE IF NOT EXISTS dispatch.proposal_lease (
  lease_id         BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL,           -- app-FK → tenant_db.roadmap.proposal.id
  tenant_db_slug   TEXT         NOT NULL,
  agency_id        TEXT         NOT NULL REFERENCES agency.agency(agency_id) ON DELETE RESTRICT,
  offer_id         BIGINT       REFERENCES dispatch.work_offer(offer_id) ON DELETE SET NULL,
  claim_id         BIGINT       REFERENCES dispatch.work_claim(id) ON DELETE SET NULL,
  role             TEXT         NOT NULL,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  expires_at       TIMESTAMPTZ  NOT NULL,
  renewed_at       TIMESTAMPTZ,
  renewal_count    INT          NOT NULL DEFAULT 0,
  released_at      TIMESTAMPTZ,
  release_reason   TEXT,           -- 'work_delivered' | 'gate_review_complete' | 'timeout' | 'error'
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Only one active lease per proposal at a time
  CONSTRAINT lease_proposal_active_unique UNIQUE (proposal_id) DEFERRABLE INITIALLY DEFERRED,

  -- release_reason required on release
  CONSTRAINT lease_release_consistent CHECK (
    (is_active = false AND released_at IS NOT NULL) OR
    (is_active = true  AND released_at IS NULL)
  )
);

-- TTL reaper: find leases that have expired but are still active
CREATE INDEX IF NOT EXISTS proposal_lease_expires_active
  ON dispatch.proposal_lease (expires_at)
  WHERE is_active = true;

-- Lookup: is proposal X currently leased?
CREATE INDEX IF NOT EXISTS proposal_lease_proposal_active
  ON dispatch.proposal_lease (proposal_id, is_active);

-- Agency query: what does this agency currently hold?
CREATE INDEX IF NOT EXISTS proposal_lease_agency_active
  ON dispatch.proposal_lease (agency_id, is_active)
  WHERE is_active = true;

CREATE OR REPLACE TRIGGER set_updated_at_proposal_lease
  BEFORE UPDATE ON dispatch.proposal_lease
  FOR EACH ROW EXECUTE FUNCTION dispatch.set_updated_at();

COMMENT ON TABLE dispatch.proposal_lease IS
  'Active work leases: one lease per proposal while an agency is working it. '
  'is_active=true enforced as a partial unique index on proposal_id (DEFERRABLE for '
  'lease handoff without gap). Replaces roadmap.proposal_lease post-P501 cutover.';

COMMENT ON COLUMN dispatch.proposal_lease.renewal_count IS
  'Incremented on each renew call. High values indicate stuck agents '
  'and may trigger the stall watchdog.';

-- ============================================================
-- dispatch.dispatch_audit — append-only event log
-- ============================================================
-- Records all offer and lease state transitions.
-- Append-only enforced with REVOKE + trigger (mirrors governance.event_log pattern).
--
-- event_type vocabulary:
--   offer_created, offer_claimed, offer_expired, offer_retracted, offer_released
--   lease_created, lease_renewed, lease_released, lease_expired, lease_force_released
CREATE TABLE IF NOT EXISTS dispatch.dispatch_audit (
  audit_id         BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type       TEXT         NOT NULL
                                CHECK (event_type IN (
                                  'offer_created','offer_claimed','offer_expired',
                                  'offer_retracted','offer_released',
                                  'lease_created','lease_renewed','lease_released',
                                  'lease_expired','lease_force_released'
                                )),
  offer_id         BIGINT,                           -- NULL for lease-only events
  lease_id         BIGINT,                           -- NULL for offer-only events
  agency_id        TEXT,
  proposal_id      BIGINT,                           -- app-FK
  tenant_db_slug   TEXT,
  actor_did        TEXT,                             -- who triggered this event
  event_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata         JSONB        NOT NULL DEFAULT '{}',

  -- Denormalised snapshot fields (remain valid after offer/lease are mutated/deleted):
  offer_state_before TEXT,
  offer_state_after  TEXT,
  lease_active_before BOOLEAN,
  lease_active_after  BOOLEAN
);

-- Time-series query: recent events for a proposal
CREATE INDEX IF NOT EXISTS dispatch_audit_proposal_time
  ON dispatch.dispatch_audit (proposal_id, event_at DESC);

-- Time-series query: recent events for an agency
CREATE INDEX IF NOT EXISTS dispatch_audit_agency_time
  ON dispatch.dispatch_audit (agency_id, event_at DESC);

-- Operational query: all events for a specific offer
CREATE INDEX IF NOT EXISTS dispatch_audit_offer
  ON dispatch.dispatch_audit (offer_id, event_at DESC)
  WHERE offer_id IS NOT NULL;

-- Append-only enforcement (a): revoke mutations from all roles
REVOKE UPDATE, DELETE ON dispatch.dispatch_audit FROM PUBLIC;

-- Append-only enforcement (b): trigger
CREATE OR REPLACE FUNCTION dispatch.deny_dispatch_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'dispatch.dispatch_audit is append-only (op=%). '
    'Do not UPDATE or DELETE audit rows.',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS dispatch_audit_no_update ON dispatch.dispatch_audit;
CREATE TRIGGER dispatch_audit_no_update
  BEFORE UPDATE ON dispatch.dispatch_audit
  FOR EACH ROW EXECUTE FUNCTION dispatch.deny_dispatch_audit_mutation();

DROP TRIGGER IF EXISTS dispatch_audit_no_delete ON dispatch.dispatch_audit;
CREATE TRIGGER dispatch_audit_no_delete
  BEFORE DELETE ON dispatch.dispatch_audit
  FOR EACH ROW EXECUTE FUNCTION dispatch.deny_dispatch_audit_mutation();

COMMENT ON TABLE dispatch.dispatch_audit IS
  'Append-only event log for all offer and lease state transitions. '
  'Denormalised before/after state fields remain valid after offer/lease rows mutate. '
  'REVOKE + trigger dual-enforcement for append-only guarantee.';

-- ============================================================
-- dispatch.capacity_snapshot — point-in-time capacity for dispatch debugging
-- ============================================================
-- This is NOT the mutable live capacity (that is agency.agency_capacity).
-- Snapshots are written by the orchestrator at offer-evaluation time to
-- record exactly what capacity state drove routing decisions.
-- Append-only (time-series), partitioned monthly.
CREATE TABLE IF NOT EXISTS dispatch.capacity_snapshot (
  snapshot_id      BIGINT       GENERATED ALWAYS AS IDENTITY,
  agency_id        TEXT         NOT NULL REFERENCES agency.agency(agency_id) ON DELETE CASCADE,
  max_concurrent   INT          NOT NULL,
  current_active   INT          NOT NULL,
  pending_offers   INT          NOT NULL DEFAULT 0,  -- offers in state='pending' for this agency
  accepted_tags    TEXT[]       NOT NULL DEFAULT '{}',
  snapshot_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  trigger_event    TEXT                              -- 'offer_evaluation' | 'reaper_run' | 'manual'
                                CHECK (trigger_event IN ('offer_evaluation','reaper_run','manual')),
  metadata         JSONB        NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (snapshot_at);

-- Latest capacity for an agency (orchestrator reads this for routing decisions)
CREATE INDEX IF NOT EXISTS capacity_snapshot_agency_time
  ON dispatch.capacity_snapshot (agency_id, snapshot_at DESC);

-- Global snapshot timeline (used by observability dashboards)
CREATE INDEX IF NOT EXISTS capacity_snapshot_time
  ON dispatch.capacity_snapshot (snapshot_at DESC);

-- Append-only enforcement
REVOKE UPDATE, DELETE ON dispatch.capacity_snapshot FROM PUBLIC;

CREATE OR REPLACE FUNCTION dispatch.deny_capacity_snapshot_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch.capacity_snapshot is append-only (op=%)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS capacity_snapshot_no_update ON dispatch.capacity_snapshot;
CREATE TRIGGER capacity_snapshot_no_update
  BEFORE UPDATE ON dispatch.capacity_snapshot
  FOR EACH ROW EXECUTE FUNCTION dispatch.deny_capacity_snapshot_mutation();

DROP TRIGGER IF EXISTS capacity_snapshot_no_delete ON dispatch.capacity_snapshot;
CREATE TRIGGER capacity_snapshot_no_delete
  BEFORE DELETE ON dispatch.capacity_snapshot
  FOR EACH ROW EXECUTE FUNCTION dispatch.deny_capacity_snapshot_mutation();

-- Monthly partitioning (90d retention, mirrors observability tables)
SELECT partman.create_parent(
  p_parent_table    => 'dispatch.capacity_snapshot',
  p_control         => 'snapshot_at',
  p_interval        => '1 month',
  p_start_partition => date_trunc('month', now())::text
);
UPDATE partman.part_config
  SET retention = '90 days', retention_keep_table = false
  WHERE parent_table = 'dispatch.capacity_snapshot';

COMMENT ON TABLE dispatch.capacity_snapshot IS
  'Point-in-time capacity snapshots written by orchestrator at offer-evaluation time. '
  'NOT the mutable live capacity (see agency.agency_capacity for that). Append-only, '
  'partitioned monthly, 90d retention. Provides audit trail for routing decisions.';

-- ============================================================
-- dispatch.fn_reap_expired_offers() — TTL reaper utility
-- ============================================================
-- Called by the orchestrator's reaper loop (not a cron job — orchestrator owns TTL).
-- Returns count of offers reaped.
CREATE OR REPLACE FUNCTION dispatch.fn_reap_expired_offers()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
BEGIN
  WITH reaped AS (
    UPDATE dispatch.work_offer
       SET state = 'expired', updated_at = clock_timestamp()
     WHERE state = 'pending'
       AND expires_at < clock_timestamp()
     RETURNING offer_id, proposal_id, agency_id, tenant_db_slug
  ),
  audit_inserts AS (
    INSERT INTO dispatch.dispatch_audit
      (event_type, offer_id, agency_id, proposal_id, tenant_db_slug,
       actor_did, offer_state_before, offer_state_after)
    SELECT 'offer_expired', r.offer_id, r.agency_id, r.proposal_id, r.tenant_db_slug,
           'did:agenthive:orchestrator', 'pending', 'expired'
      FROM reaped r
  )
  SELECT COUNT(*) INTO v_count FROM reaped;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION dispatch.fn_reap_expired_offers() IS
  'TTL reaper for pending offers past their expires_at. '
  'Called by orchestrator reaper loop. Returns count of offers expired. '
  'Writes audit rows atomically with the state change.';

-- ============================================================
-- dispatch.fn_reap_expired_leases() — lease TTL reaper
-- ============================================================
CREATE OR REPLACE FUNCTION dispatch.fn_reap_expired_leases()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
BEGIN
  WITH reaped AS (
    UPDATE dispatch.proposal_lease
       SET is_active = false,
           released_at = clock_timestamp(),
           release_reason = 'timeout',
           updated_at = clock_timestamp()
     WHERE is_active = true
       AND expires_at < clock_timestamp()
     RETURNING lease_id, proposal_id, agency_id, tenant_db_slug
  ),
  audit_inserts AS (
    INSERT INTO dispatch.dispatch_audit
      (event_type, lease_id, agency_id, proposal_id, tenant_db_slug,
       actor_did, lease_active_before, lease_active_after)
    SELECT 'lease_expired', r.lease_id, r.agency_id, r.proposal_id, r.tenant_db_slug,
           'did:agenthive:orchestrator', true, false
      FROM reaped r
  )
  SELECT COUNT(*) INTO v_count FROM reaped;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION dispatch.fn_reap_expired_leases() IS
  'TTL reaper for active leases past their expires_at. Returns count of leases expired. '
  'Sets release_reason=timeout and writes audit rows atomically.';

-- ============================================================
-- Views
-- ============================================================

CREATE OR REPLACE VIEW dispatch.v_active_leases AS
SELECT
  l.lease_id,
  l.proposal_id,
  l.tenant_db_slug,
  l.agency_id,
  l.role,
  l.expires_at,
  EXTRACT(EPOCH FROM (l.expires_at - now()))::int AS seconds_until_expiry,
  l.renewal_count,
  l.created_at
FROM dispatch.proposal_lease l
WHERE l.is_active = true;

COMMENT ON VIEW dispatch.v_active_leases IS
  'All currently active leases with time-until-expiry. '
  'Used by orchestrator to detect stalled agents and by the stall watchdog.';

CREATE OR REPLACE VIEW dispatch.v_pending_offers AS
SELECT
  o.offer_id,
  o.proposal_id,
  o.tenant_db_slug,
  o.agency_id,
  o.role,
  o.priority,
  o.expires_at,
  EXTRACT(EPOCH FROM (o.expires_at - now()))::int AS seconds_until_expiry
FROM dispatch.work_offer o
WHERE o.state = 'pending';

COMMENT ON VIEW dispatch.v_pending_offers IS
  'Pending work offers. Orchestrator uses this to detect agencies that have not '
  'responded to an offer within the TTL.';

-- ============================================================
-- Role grant matrix (dispatch schema)
-- ============================================================
-- Conditional on role existence (safe to run before 000-roles.sql in test envs).
DO $$
BEGIN
  -- orchestrator: full CRUD on mutable tables, INSERT-only on audit/snapshot
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON dispatch.work_offer TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON dispatch.proposal_lease TO agenthive_orchestrator;
    GRANT SELECT, INSERT           ON dispatch.dispatch_audit TO agenthive_orchestrator;
    GRANT SELECT, INSERT           ON dispatch.capacity_snapshot TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE, DELETE ON dispatch.work_claim TO agenthive_orchestrator;
    GRANT SELECT ON dispatch.v_active_leases, dispatch.v_pending_offers TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION dispatch.fn_reap_expired_offers() TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION dispatch.fn_reap_expired_leases() TO agenthive_orchestrator;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dispatch TO agenthive_orchestrator;
  END IF;

  -- agency: can read its own offers/leases, INSERT claims and audit events
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_agency;
    GRANT SELECT ON dispatch.work_offer TO agenthive_agency;
    GRANT SELECT ON dispatch.proposal_lease TO agenthive_agency;
    GRANT SELECT, INSERT, UPDATE ON dispatch.work_claim TO agenthive_agency;
    GRANT SELECT, INSERT           ON dispatch.dispatch_audit TO agenthive_agency;
    GRANT SELECT, INSERT           ON dispatch.capacity_snapshot TO agenthive_agency;
    GRANT SELECT ON dispatch.v_active_leases, dispatch.v_pending_offers TO agenthive_agency;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dispatch TO agenthive_agency;
  END IF;

  -- observability: read-only across all dispatch tables
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA dispatch TO agenthive_observability;
  END IF;

  -- a2a: read-only (needs offer/lease state for liaison coordination)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_a2a') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_a2a;
    GRANT SELECT ON dispatch.work_offer, dispatch.proposal_lease TO agenthive_a2a;
    GRANT SELECT ON dispatch.v_active_leases, dispatch.v_pending_offers TO agenthive_a2a;
  END IF;
END $$;
