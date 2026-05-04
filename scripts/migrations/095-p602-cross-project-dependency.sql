\set ON_ERROR_STOP on

-- ============================================================
-- P602 — cross-project dependency schema  (replaces 086)
-- ============================================================
-- Migration 086 failed to apply because it enumerated only 11
-- proposal_event event_types; the live table has 25. This
-- migration runs the full P602 DDL with the complete type list.
-- ============================================================

BEGIN;

-- ============================================================
-- Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS dependency;

COMMENT ON SCHEMA dependency IS
  'Cross-project dependency graph: edges, kinds, consistency checks. '
  'Enables coordinated work across project boundaries.';

-- ============================================================
-- dependency.dependency_kind_catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS dependency.dependency_kind_catalog (
  id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT         UNIQUE NOT NULL,
  description     TEXT,
  is_blocking     BOOL         NOT NULL DEFAULT true,
  owner_did       TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at   TIMESTAMPTZ,
  retire_after    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE dependency.dependency_kind_catalog IS
  'Registry of valid dependency edge kinds. is_blocking=true means the edge '
  'is a hard gate: the from-project cannot advance until the to-project delivers.';

INSERT INTO dependency.dependency_kind_catalog (name, is_blocking, description)
VALUES
  ('schema_migration', true,  'DB schema migration must land in target project first'),
  ('api_contract',     true,  'API contract must be finalised in target project first'),
  ('data_seed',        true,  'Reference data must be seeded in target project first'),
  ('soft_reference',   false, 'Informational reference; no blocking gate enforced')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- dependency.cross_project_dependency
-- ============================================================
CREATE TABLE IF NOT EXISTS dependency.cross_project_dependency (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_project_id  BIGINT       NOT NULL REFERENCES roadmap.project(project_id),
  to_project_id    BIGINT       NOT NULL REFERENCES roadmap.project(project_id),
  kind_id          BIGINT       NOT NULL
    REFERENCES dependency.dependency_kind_catalog(id) ON DELETE RESTRICT,
  reference_id     TEXT         NOT NULL,
  reference_type   TEXT         NOT NULL,
  resolved_at      TIMESTAMPTZ,
  notes            TEXT,
  owner_did        TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cross_project_dependency_unique
    UNIQUE (from_project_id, to_project_id, reference_id),
  CONSTRAINT cross_project_no_self_loop
    CHECK (from_project_id != to_project_id)
);

COMMENT ON TABLE dependency.cross_project_dependency IS
  'Cross-project dependency edges. Each row is a directed edge from one project to '
  'another, typed by kind_id, anchored by reference_id/reference_type. '
  'resolved_at tracks when the dependency was satisfied.';

CREATE INDEX IF NOT EXISTS idx_cross_project_dep_from
  ON dependency.cross_project_dependency(from_project_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_dep_to
  ON dependency.cross_project_dependency(to_project_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_dep_kind
  ON dependency.cross_project_dependency(kind_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_dep_unresolved
  ON dependency.cross_project_dependency(resolved_at)
  WHERE resolved_at IS NULL;

-- ============================================================
-- Trigger: set_updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION dependency.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_dependency_kind_catalog_updated_at
  BEFORE UPDATE ON dependency.dependency_kind_catalog
  FOR EACH ROW EXECUTE FUNCTION dependency.set_updated_at();

CREATE OR REPLACE TRIGGER trg_cross_project_dependency_updated_at
  BEFORE UPDATE ON dependency.cross_project_dependency
  FOR EACH ROW EXECUTE FUNCTION dependency.set_updated_at();

-- ============================================================
-- Trigger: dependency_resolved_notify
-- ============================================================
CREATE OR REPLACE FUNCTION dependency.notify_dependency_resolved()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL THEN
    PERFORM pg_notify('dependency_resolved', json_build_object(
      'id',              NEW.id,
      'from_project_id', NEW.from_project_id,
      'to_project_id',   NEW.to_project_id,
      'kind_id',         NEW.kind_id,
      'reference_id',    NEW.reference_id,
      'reference_type',  NEW.reference_type
    )::text);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_dependency_resolved_notify
  AFTER UPDATE ON dependency.cross_project_dependency
  FOR EACH ROW EXECUTE FUNCTION dependency.notify_dependency_resolved();

-- ============================================================
-- Extend proposal_event_type_check to include P602 event types
-- Full list = current 25 values + cross_dep_orphan_detected +
--             cross_dep_cycle_detected
-- ============================================================
ALTER TABLE roadmap_proposal.proposal_event DROP CONSTRAINT IF EXISTS proposal_event_type_check;
ALTER TABLE roadmap_proposal.proposal_event ADD CONSTRAINT proposal_event_type_check CHECK (
  event_type = ANY (ARRAY[
    'status_changed','decision_made','lease_claimed','lease_released',
    'dependency_added','dependency_resolved','ac_updated','review_submitted',
    'maturity_changed','milestone_achieved','proposal_created',
    'gate_dispatched','gate_advanced','gate_held','gate_failed',
    'agent_dispatched','agent_completed','agent_failed',
    'agent_sos','agent_ask','agent_decision',
    'squad_dispatched',
    'frontier_audit_flag','frontier_audit_pause','frontier_audit_critical',
    'cross_dep_orphan_detected','cross_dep_cycle_detected'
  ])
);

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_agent') THEN
    GRANT USAGE ON SCHEMA dependency TO roadmap_agent;
    GRANT SELECT ON dependency.dependency_kind_catalog TO roadmap_agent;
    GRANT SELECT, INSERT, UPDATE ON dependency.cross_project_dependency TO roadmap_agent;
    GRANT USAGE ON SEQUENCE dependency.cross_project_dependency_id_seq TO roadmap_agent;
  END IF;
END $$;

-- agent_read / agent_write (agenthive role set)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_read') THEN
    GRANT USAGE ON SCHEMA dependency TO agent_read;
    GRANT SELECT ON dependency.dependency_kind_catalog TO agent_read;
    GRANT SELECT ON dependency.cross_project_dependency TO agent_read;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_write') THEN
    GRANT USAGE ON SCHEMA dependency TO agent_write;
    GRANT SELECT ON dependency.dependency_kind_catalog TO agent_write;
    GRANT SELECT, INSERT, UPDATE, DELETE ON dependency.cross_project_dependency TO agent_write;
    GRANT USAGE ON SEQUENCE dependency.cross_project_dependency_id_seq TO agent_write;
  END IF;
END $$;

COMMIT;

-- Rollback:
--   DROP SCHEMA IF EXISTS dependency CASCADE;
--   -- Restore proposal_event_type_check to its pre-P602 25-value form.
