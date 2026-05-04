\set ON_ERROR_STOP on

-- ============================================================
-- P602 — cross-project dependency schema
-- ============================================================
-- Target DB:  agenthive (project tenant DB)
-- Owner:      agenthive_admin
-- Roles:      roadmap_agent (rw on cross_project_dependency)
--
-- DDL matches database/ddl/hivecentral/011-dependency.sql with
-- agenthive adaptations:
--   - FK → roadmap.project(project_id) instead of control_project.project(id)
--   - No CASCADE on project FKs (NO ACTION default)
--   - Role: roadmap_agent (agenthive's role)
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

-- Seed standard kinds (idempotent)
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
    UNIQUE (from_project_id, to_project_id, reference_id)
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
-- Trigger: set_updated_at (created once in dependency schema)
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
-- Fires pg_notify('dependency_resolved') when resolved_at transitions NULL → non-NULL
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
-- ============================================================
ALTER TABLE roadmap_proposal.proposal_event DROP CONSTRAINT IF EXISTS proposal_event_type_check;
ALTER TABLE roadmap_proposal.proposal_event ADD CONSTRAINT proposal_event_type_check CHECK (
  event_type = ANY (ARRAY[
    'status_changed','decision_made','lease_claimed','lease_released',
    'dependency_added','dependency_resolved','ac_updated','review_submitted',
    'maturity_changed','milestone_achieved','proposal_created',
    'cross_dep_orphan_detected','cross_dep_cycle_detected'
  ])
);

-- ============================================================
-- Grants to roadmap_agent
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

COMMIT;
