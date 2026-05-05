-- Migration 058 — P602: Cross-project dependency graph
--
-- Creates dependency schema with typed edge table and kind catalog.
-- Extends proposal_event_type_check to include cross-project event types.
-- v1: nightly batch job only — no pg_notify / LISTEN DDL.
-- FK target: roadmap.project(project_id) from migration 050.

BEGIN;

-- ── Preflight: verify FK target tables exist ──────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap' AND table_name = 'project'
  ) THEN
    RAISE EXCEPTION 'migration 058 requires roadmap.project (migration 050)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'roadmap_proposal' AND table_name = 'proposal_event'
  ) THEN
    RAISE EXCEPTION 'migration 058 requires roadmap_proposal.proposal_event';
  END IF;
END $$;

-- ── 1. Schema ─────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS dependency;

-- ── 2. Kind catalog ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dependency.dependency_kind_catalog (
  kind            TEXT PRIMARY KEY,
  is_directional  BOOLEAN NOT NULL DEFAULT true,
  cycle_check     BOOLEAN NOT NULL DEFAULT false,
  description     TEXT
);

-- ── 3. Cross-project edge table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dependency.cross_project_dependency (
  edge_id          BIGSERIAL PRIMARY KEY,
  from_project_id  BIGINT NOT NULL REFERENCES roadmap.project(project_id),
  from_proposal_id BIGINT NOT NULL,
  to_project_id    BIGINT NOT NULL REFERENCES roadmap.project(project_id),
  to_proposal_id   BIGINT NOT NULL,
  kind             TEXT NOT NULL REFERENCES dependency.dependency_kind_catalog(kind),
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cross_project_no_self_loop
    CHECK (from_project_id != to_project_id),
  CONSTRAINT cross_project_dep_unique
    UNIQUE (from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_cross_dep_from
  ON dependency.cross_project_dependency (from_project_id, from_proposal_id);

CREATE INDEX IF NOT EXISTS idx_cross_dep_to
  ON dependency.cross_project_dependency (to_project_id, to_proposal_id);

CREATE INDEX IF NOT EXISTS idx_cross_dep_unresolved
  ON dependency.cross_project_dependency (resolved_at)
  WHERE resolved_at IS NULL;

-- ── 4. Seed kind catalog (4 rows) ─────────────────────────────────────────────

INSERT INTO dependency.dependency_kind_catalog (kind, is_directional, cycle_check, description)
VALUES
  ('blocks',            true,  true,  'from blocks progress on to; nightly cycle check enabled'),
  ('informed_by',       true,  false, 'from is informed by to; informational only, no cycle check'),
  ('supersedes',        true,  false, 'from supersedes to; directional replacement'),
  ('requires_artifact', false, false, 'mutual artifact dependency; not directional, no cycle check')
ON CONFLICT (kind) DO NOTHING;

-- ── 5. Extend proposal_event_type_check ──────────────────────────────────────
-- Full list (11 existing + 2 new = 13 total):
-- Existing from baseline DDL line 2418:
--   status_changed, decision_made, lease_claimed, lease_released,
--   dependency_added, dependency_resolved, ac_updated, review_submitted,
--   maturity_changed, milestone_achieved, proposal_created
-- New:
--   cross_dep_orphan_detected, cross_dep_cycle_detected

ALTER TABLE roadmap_proposal.proposal_event
  DROP CONSTRAINT IF EXISTS proposal_event_type_check;

ALTER TABLE roadmap_proposal.proposal_event
  ADD CONSTRAINT proposal_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'status_changed','decision_made','lease_claimed','lease_released',
    'dependency_added','dependency_resolved','ac_updated','review_submitted',
    'maturity_changed','milestone_achieved','proposal_created',
    'cross_dep_orphan_detected','cross_dep_cycle_detected'
  ]));

-- ── 6. Grants ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA dependency TO roadmap_agent;
GRANT SELECT ON dependency.dependency_kind_catalog TO roadmap_agent;
GRANT SELECT, INSERT ON dependency.cross_project_dependency TO roadmap_agent;
GRANT USAGE ON SEQUENCE dependency.cross_project_dependency_edge_id_seq TO roadmap_agent;

COMMIT;
