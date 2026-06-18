-- ============================================================
-- P820 — hiveCentral.dispatch schema (full)
-- Queue/orchestrator tables: work_offer, proposal_lease,
-- dispatch_audit (append-only), capacity_snapshot.
-- Extends the P595 stub (dispatch.work_claim) in 005-dispatch-stub.sql.
-- ============================================================
-- Target DB:  hiveCentral
-- Owner:      agenthive_admin
-- Roles:      agenthive_orchestrator (rw offers/leases/capacity, r audit)
--             agenthive_agency (rw leases, r offers/capacity)
--             agenthive_observability (r all)
-- Depends on: 001-core.sql (core), 003-agency.sql (agency)
-- Apply after: 005-dispatch-stub.sql
-- Min PG:     16
-- ============================================================
-- Enum strategy: soft TEXT+CHECK throughout (NO PG ENUM).
-- Rationale: PG ENUMs require DDL to extend; TEXT+CHECK allows
-- additive ALTER CONSTRAINT as the state machine grows.
-- ============================================================
-- Proposal placement decision (Option A — confirmed):
-- Proposals live in each tenant DB (roadmap schema).
-- dispatch.work_offer.proposal_id / dispatch.proposal_lease.proposal_id
-- are cross-DB application-level FKs — Postgres cannot enforce them.
-- Invariants and audit queries are documented at the bottom of this file.
-- Option B (thin cross-tenant index in hiveCentral) is REJECTED: it
-- would require hiveCentral to mirror mutable proposal state, creating
-- a synchronisation hazard with no benefit over Option A's audit queries.
-- ============================================================

\set ON_ERROR_STOP on

-- Pre-flight: fail loudly if dependencies are absent
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core') THEN
    RAISE EXCEPTION '005-dispatch-full.sql requires core schema; apply 001-core.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'agency') THEN
    RAISE EXCEPTION '005-dispatch-full.sql requires agency schema; apply 003-agency.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'dispatch' AND table_name = 'work_claim') THEN
    RAISE EXCEPTION '005-dispatch-full.sql requires dispatch.work_claim; apply 005-dispatch-stub.sql first';
  END IF;
END $$;

-- Schema already created by 005-dispatch-stub.sql
CREATE SCHEMA IF NOT EXISTS dispatch;

COMMENT ON SCHEMA dispatch IS
  'P820 hiveCentral queue/orchestrator surface: work offers, proposal leases, '
  'capacity snapshots, and append-only dispatch audit trail. '
  'Proposal IDs are cross-DB application-level FKs (Option A) — see file header.';

-- ============================================================
-- dispatch.work_offer
-- One row per unit of work the orchestrator wants an agency to accept.
-- State machine: pending → claimed | expired | retracted
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.work_offer (
  offer_id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Cross-DB application-level FK: proposal_id references tenant_db.roadmap.proposal.id
  -- Enforcement: application must verify existence before insert; audit query below.
  proposal_id        BIGINT       NOT NULL,
  project_slug       TEXT         NOT NULL,         -- identifies the tenant DB (control_project.project.slug)
  agency_id          TEXT         REFERENCES agency.agency(agency_id) ON DELETE SET NULL,
  role               TEXT         NOT NULL,         -- e.g. 'enrichment_agent', 'gate_decision_agent'
  priority           INT          NOT NULL DEFAULT 0,
  state              TEXT         NOT NULL DEFAULT 'pending'
                                 CHECK (state IN ('pending','claimed','expired','retracted')),
  -- cost_snapshot: pricing snapshot at offer time (immutable — mirrors work_claim contract)
  cost_snapshot      JSONB        NOT NULL DEFAULT '{}',
  -- offer window
  offered_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  claimed_at         TIMESTAMPTZ,
  retracted_at       TIMESTAMPTZ,
  retraction_reason  TEXT,
  metadata           JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE dispatch.work_offer IS
  'P820: orchestrator-issued work units. One offer per (proposal, role, window). '
  'State machine: pending → claimed (agency accepted) | expired (window closed) '
  '| retracted (orchestrator cancelled). '
  'proposal_id is a cross-DB app-level FK to the tenant DB roadmap.proposal table.';
COMMENT ON COLUMN dispatch.work_offer.cost_snapshot IS
  'Route pricing snapped at offer creation. Immutable after insert. '
  'Provides stable billing reference even if model_route changes later.';
COMMENT ON COLUMN dispatch.work_offer.project_slug IS
  'Identifies which tenant DB holds this proposal. '
  'Resolves via control_project.project(slug) → project_db(dsn).';

-- Orchestrator poll: fetch next claimable offers ordered by priority
CREATE INDEX IF NOT EXISTS work_offer_dispatch
  ON dispatch.work_offer (priority DESC, offered_at ASC)
  WHERE state = 'pending';

-- Expire sweep: all offers past their window
CREATE INDEX IF NOT EXISTS work_offer_expire_sweep
  ON dispatch.work_offer (expires_at)
  WHERE state = 'pending';

-- Agency claim lookup: what offer is this agency currently working?
CREATE INDEX IF NOT EXISTS work_offer_agency_active
  ON dispatch.work_offer (agency_id)
  WHERE state = 'claimed';

-- Per-proposal lookup (cross-DB invariant auditing)
CREATE INDEX IF NOT EXISTS work_offer_proposal
  ON dispatch.work_offer (proposal_id, project_slug, state);

-- Immutability guard on cost_snapshot (mirrors stub pattern)
CREATE OR REPLACE FUNCTION dispatch.fn_guard_offer_cost_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cost_snapshot IS DISTINCT FROM OLD.cost_snapshot THEN
    RAISE EXCEPTION
      'dispatch.work_offer.cost_snapshot is immutable after insert (offer_id=%). '
      'To reprice, retract and create a new offer.',
      OLD.offer_id;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_offer_guard_cost_snapshot') THEN
    CREATE TRIGGER trg_work_offer_guard_cost_snapshot
      BEFORE UPDATE ON dispatch.work_offer
      FOR EACH ROW EXECUTE FUNCTION dispatch.fn_guard_offer_cost_snapshot();
  END IF;
END $$;

-- ============================================================
-- dispatch.proposal_lease
-- Active claim: an agency has taken ownership of a proposal for a window.
-- Exactly one is_active=true row per proposal_id/project_slug at any time
-- (enforced by partial unique index).
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.proposal_lease (
  lease_id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Cross-DB application-level FK: proposal_id → tenant_db.roadmap.proposal.id
  proposal_id        BIGINT       NOT NULL,
  project_slug       TEXT         NOT NULL,
  agency_id          TEXT         NOT NULL REFERENCES agency.agency(agency_id) ON DELETE RESTRICT,
  offer_id           BIGINT       REFERENCES dispatch.work_offer(offer_id) ON DELETE SET NULL,
  role               TEXT         NOT NULL,
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  claimed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  released_at        TIMESTAMPTZ,
  release_reason     TEXT         CHECK (release_reason IN (
                                    'work_delivered','gate_review_complete',
                                    'expired','force_released','error')),
  maturity_on_release TEXT,       -- maturity the proposal should be set to on release (hint only)
  metadata           JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE dispatch.proposal_lease IS
  'P820: active agency claim on a proposal. At most one is_active=true row per '
  '(proposal_id, project_slug). Released via release_reason so orchestrator knows '
  'whether to requeue (expired/error) or advance (work_delivered).';

-- One active lease per (proposal, project) — core queue invariant
CREATE UNIQUE INDEX IF NOT EXISTS proposal_lease_one_active
  ON dispatch.proposal_lease (proposal_id, project_slug)
  WHERE is_active = true;

-- Expire-reaper sweep: find leases past their window
CREATE INDEX IF NOT EXISTS proposal_lease_expire_sweep
  ON dispatch.proposal_lease (expires_at)
  WHERE is_active = true;

-- Per-agency active load
CREATE INDEX IF NOT EXISTS proposal_lease_agency_active
  ON dispatch.proposal_lease (agency_id)
  WHERE is_active = true;

-- Per-proposal history (for audit)
CREATE INDEX IF NOT EXISTS proposal_lease_proposal_history
  ON dispatch.proposal_lease (proposal_id, project_slug, claimed_at DESC);

-- ============================================================
-- dispatch.dispatch_audit  (append-only event log)
-- One row per state transition on an offer or lease.
-- REVOKE UPDATE/DELETE + trigger enforce immutability.
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.dispatch_audit (
  audit_id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type         TEXT         NOT NULL CHECK (event_type IN (
                                    'offer_created','offer_claimed','offer_expired',
                                    'offer_retracted','lease_created','lease_released',
                                    'lease_expired','lease_force_released',
                                    'capacity_updated','dispatch_stall_detected')),
  offer_id           BIGINT,      -- FK hint; not enforced to survive offer deletion
  lease_id           BIGINT,      -- FK hint; not enforced to survive lease archival
  agency_id          TEXT,
  proposal_id        BIGINT,
  project_slug       TEXT,
  role               TEXT,
  event_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_did          TEXT,        -- identity.principal DID that caused the event (if known)
  metadata           JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE dispatch.dispatch_audit IS
  'P820: append-only event log for all offer/lease state transitions. '
  'Used for orchestrator cost accounting, stall detection, and compliance. '
  'Immutability enforced by REVOKE + trigger (dual defence).';

-- Append-only enforcement (a): role grants
REVOKE UPDATE, DELETE ON dispatch.dispatch_audit FROM PUBLIC;

-- Append-only enforcement (b): trigger
CREATE OR REPLACE FUNCTION dispatch.deny_dispatch_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch.dispatch_audit is append-only (audit_id=%)', OLD.audit_id;
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

-- Query patterns
CREATE INDEX IF NOT EXISTS dispatch_audit_recent
  ON dispatch.dispatch_audit (event_at DESC);

CREATE INDEX IF NOT EXISTS dispatch_audit_proposal
  ON dispatch.dispatch_audit (proposal_id, project_slug, event_at DESC);

CREATE INDEX IF NOT EXISTS dispatch_audit_agency
  ON dispatch.dispatch_audit (agency_id, event_at DESC)
  WHERE agency_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dispatch_audit_event_type
  ON dispatch.dispatch_audit (event_type, event_at DESC);

-- ============================================================
-- dispatch.capacity_snapshot
-- Point-in-time snapshot of agency slot availability.
-- Written by each agency on registration and whenever capacity changes.
-- Orchestrator reads the latest snapshot per agency to decide dispatch.
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch.capacity_snapshot (
  snapshot_id        BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agency_id          TEXT         NOT NULL REFERENCES agency.agency(agency_id) ON DELETE CASCADE,
  max_concurrent     INT          NOT NULL DEFAULT 1 CHECK (max_concurrent > 0),
  current_active     INT          NOT NULL DEFAULT 0 CHECK (current_active >= 0),
  available_slots    INT          GENERATED ALWAYS AS (max_concurrent - current_active) STORED,
  host_id            BIGINT       REFERENCES core.host(host_id) ON DELETE SET NULL,
  snapshot_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata           JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE dispatch.capacity_snapshot IS
  'P820: immutable point-in-time capacity readings per agency. '
  'Orchestrator polls the latest row per agency (idx: agency_id, snapshot_at DESC) '
  'to decide whether to issue a new work_offer. '
  'available_slots = max_concurrent - current_active (generated column).';

-- Orchestrator poll: latest capacity per agency
CREATE INDEX IF NOT EXISTS capacity_snapshot_latest
  ON dispatch.capacity_snapshot (agency_id, snapshot_at DESC);

-- Available agencies for dispatch
CREATE INDEX IF NOT EXISTS capacity_snapshot_available
  ON dispatch.capacity_snapshot (snapshot_at DESC)
  WHERE available_slots > 0;

-- ============================================================
-- Views
-- ============================================================

-- Active dispatch queue: pending offers with slot availability
CREATE OR REPLACE VIEW dispatch.v_pending_offers AS
SELECT
  wo.offer_id,
  wo.proposal_id,
  wo.project_slug,
  wo.agency_id,
  wo.role,
  wo.priority,
  wo.offered_at,
  wo.expires_at,
  cs.available_slots,
  cs.snapshot_at AS capacity_as_of
FROM dispatch.work_offer wo
LEFT JOIN LATERAL (
  SELECT available_slots, snapshot_at
    FROM dispatch.capacity_snapshot
   WHERE agency_id = wo.agency_id
   ORDER BY snapshot_at DESC
   LIMIT 1
) cs ON true
WHERE wo.state = 'pending'
  AND wo.expires_at > now()
ORDER BY wo.priority DESC, wo.offered_at ASC;

COMMENT ON VIEW dispatch.v_pending_offers IS
  'Live dispatch queue: pending non-expired offers joined with latest agency capacity. '
  'Orchestrator polls this view; order by priority DESC, offered_at ASC.';

-- Active leases — for orchestrator capacity / stall detection
CREATE OR REPLACE VIEW dispatch.v_active_leases AS
SELECT
  pl.lease_id,
  pl.proposal_id,
  pl.project_slug,
  pl.agency_id,
  pl.role,
  pl.claimed_at,
  pl.expires_at,
  EXTRACT(EPOCH FROM (now() - pl.claimed_at))::int AS age_seconds,
  CASE
    WHEN now() > pl.expires_at THEN 'expired'
    WHEN now() > pl.expires_at - interval '5 minutes' THEN 'expiring_soon'
    ELSE 'active'
  END AS lease_health
FROM dispatch.proposal_lease pl
WHERE pl.is_active = true;

COMMENT ON VIEW dispatch.v_active_leases IS
  'Active leases with staleness signal. lease_health: active | expiring_soon | expired. '
  'Expired rows in this view are candidates for the lease-reaper cron job.';

-- ============================================================
-- Role/grant matrix
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON dispatch.work_offer TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON dispatch.proposal_lease TO agenthive_orchestrator;
    GRANT SELECT, INSERT ON dispatch.dispatch_audit TO agenthive_orchestrator;
    GRANT SELECT, INSERT ON dispatch.capacity_snapshot TO agenthive_orchestrator;
    GRANT SELECT ON dispatch.v_pending_offers, dispatch.v_active_leases TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_agency;
    GRANT SELECT ON dispatch.work_offer TO agenthive_agency;
    GRANT SELECT, INSERT, UPDATE ON dispatch.proposal_lease TO agenthive_agency;
    GRANT SELECT, INSERT ON dispatch.dispatch_audit TO agenthive_agency;
    GRANT SELECT, INSERT ON dispatch.capacity_snapshot TO agenthive_agency;
    GRANT SELECT ON dispatch.v_pending_offers TO agenthive_agency;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA dispatch TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA dispatch TO agenthive_observability;
    GRANT SELECT ON dispatch.v_pending_offers, dispatch.v_active_leases TO agenthive_observability;
  END IF;
END $$;

-- ============================================================
-- Cross-DB FK invariants (Application-Level — Option A)
-- Postgres cannot enforce FKs across databases.
-- These invariants must be verified by the application layer on every INSERT.
-- Audit queries below allow periodic reconciliation.
-- ============================================================

COMMENT ON COLUMN dispatch.work_offer.proposal_id IS
  'Cross-DB application-level FK: references tenant_db.roadmap.proposal.id. '
  'Use project_slug to resolve the tenant DB via control_project.project.slug → project_db.dsn. '
  'Audit query: SELECT wo.offer_id, wo.proposal_id, wo.project_slug '
  '  FROM dispatch.work_offer wo '
  '  WHERE NOT EXISTS ( <connect to tenant_db> SELECT 1 FROM roadmap.proposal p WHERE p.id = wo.proposal_id ).';

COMMENT ON COLUMN dispatch.proposal_lease.proposal_id IS
  'Cross-DB application-level FK: references tenant_db.roadmap.proposal.id. '
  'Orphan audit: join work_offer on offer_id; verify proposal still exists in tenant DB.';

-- ============================================================
-- Dispatch grant matrix summary (documentation)
-- ============================================================
-- Table                    | agenthive_admin | agenthive_orchestrator | agenthive_agency | agenthive_observability
-- ─────────────────────────|─────────────────|───────────────────────|──────────────────|────────────────────────
-- dispatch.work_offer      | ALL             | SELECT,INSERT,UPDATE  | SELECT           | SELECT
-- dispatch.proposal_lease  | ALL             | SELECT,INSERT,UPDATE  | SELECT,INSERT,UPDATE | SELECT
-- dispatch.dispatch_audit  | ALL             | SELECT,INSERT         | SELECT,INSERT    | SELECT
-- dispatch.capacity_snapshot| ALL            | SELECT,INSERT         | SELECT,INSERT    | SELECT
-- dispatch.work_claim      | ALL             | (from stub)           | (from stub)      | SELECT
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Note: agenthive_orchestrator holds UPDATE on work_offer to transition state (pending→claimed,
-- pending→retracted, claimed→expired). Agency role holds UPDATE on proposal_lease so agencies
-- can release their own leases without going through the orchestrator.
