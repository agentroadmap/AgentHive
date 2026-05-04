-- ============================================================
-- P602 — cross-project dependency schema
-- ============================================================
-- Target DB:  hiveCentral
-- Owner:      agenthive_admin
-- Roles:      roadmap_agent (rw on cross_project_dependency)
-- ============================================================

\set ON_ERROR_STOP on

-- Create dependency schema
CREATE SCHEMA IF NOT EXISTS dependency;

COMMENT ON SCHEMA dependency IS
  'Cross-project dependency graph: edges, kinds, consistency checks. '
  'Enables coordinated work across project boundaries.';

-- ============================================================
-- dependency.dependency_kind_catalog
-- ============================================================
-- Canonical registry of valid edge types. Seed idempotent via ON CONFLICT.
-- is_directional: true → edges have direction (from→to); false → undirected
-- cycle_check: true → nightly job enforces acyclicity
CREATE TABLE IF NOT EXISTS dependency.dependency_kind_catalog (
    kind TEXT PRIMARY KEY,
    is_directional BOOLEAN NOT NULL DEFAULT true,
    cycle_check BOOLEAN NOT NULL DEFAULT false,
    description TEXT
);

COMMENT ON TABLE dependency.dependency_kind_catalog IS
  'Registry of valid dependency kinds. is_directional controls edge semantics; '
  'cycle_check triggers nightly acyclicity job.';

-- Seed: standard kinds (idempotent)
INSERT INTO dependency.dependency_kind_catalog (kind, is_directional, cycle_check, description)
VALUES
  ('blocks', true, true, 'Blocking dependency — from must complete before to can advance'),
  ('informed_by', true, false, 'Informational dependency — no blocking, no cycle check'),
  ('supersedes', true, false, 'This proposal supersedes the referenced one'),
  ('requires_artifact', false, false, 'Requires a specific artifact from the referenced proposal')
ON CONFLICT (kind) DO NOTHING;

-- ============================================================
-- dependency.cross_project_dependency
-- ============================================================
-- Persistent edge store. Each row describes a directed edge from one proposal to another,
-- possibly across project boundaries. Unique constraint prevents duplicate edges.
-- resolved_at: NULL while active; set when dependency is manually marked as resolved.
CREATE TABLE IF NOT EXISTS dependency.cross_project_dependency (
    edge_id BIGSERIAL PRIMARY KEY,
    from_project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id),
    from_proposal_id BIGINT NOT NULL,
    to_project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id),
    to_proposal_id BIGINT NOT NULL,
    kind TEXT NOT NULL REFERENCES dependency.dependency_kind_catalog(kind),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT cross_project_no_self_loop CHECK (from_project_id != to_project_id),
    CONSTRAINT cross_project_dependency_unique UNIQUE (from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind)
);

COMMENT ON TABLE dependency.cross_project_dependency IS
  'Cross-project dependency edges. Each row is a directed edge from a proposal in one project '
  'to a proposal in another. Unique constraint prevents duplicate edges. resolved_at tracks '
  'manual resolution by operators.';

CREATE INDEX IF NOT EXISTS idx_cross_project_from_project
  ON dependency.cross_project_dependency(from_project_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_to_project
  ON dependency.cross_project_dependency(to_project_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_kind
  ON dependency.cross_project_dependency(kind)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cross_project_unresolved
  ON dependency.cross_project_dependency(resolved_at)
  WHERE resolved_at IS NULL;

-- ============================================================
-- Extend proposal_event_type_check constraint to include new event types
-- ============================================================
-- Add 'cross_dep_orphan_detected' and 'cross_dep_cycle_detected' to the allowed event types.
-- First read and preserve existing types from the baseline.
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
    GRANT SELECT, INSERT ON dependency.cross_project_dependency TO roadmap_agent;
    GRANT USAGE ON SEQUENCE dependency.cross_project_dependency_edge_id_seq TO roadmap_agent;
  END IF;
END $$;

COMMIT;
