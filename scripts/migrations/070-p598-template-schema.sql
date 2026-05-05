-- ============================================================
-- Migration 070 — P598: template schema (immutable versioned workflow templates)
-- ============================================================
-- Applies:
--   1. template schema + workflow_template table + immutability trigger
--   2. workflow_active schema + workflow_template_copy (tenant snapshot)
--   3. roadmap.project.template_id FK column
--   4. template_backfill_orphans log table
--   5. Seeds: rfc-5-stage@v1, lightweight-3-stage@v1
--   6. Backfill: assigns rfc-5-stage@v1 to projects using RFC states
-- ============================================================

BEGIN;

-- ============================================================
-- 1. template schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS template;

CREATE TABLE IF NOT EXISTS template.workflow_template (
  template_id      TEXT        PRIMARY KEY
                               CHECK (template_id ~ '^[a-z][a-z0-9-]*@v[1-9][0-9]*$'),
  family           TEXT        NOT NULL,
  version          INT         NOT NULL CHECK (version >= 1),
  display_name     TEXT        NOT NULL,
  description      TEXT,
  states           JSONB       NOT NULL,
  gates            JSONB       NOT NULL,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_did        TEXT        NOT NULL,
  lifecycle_status TEXT        NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  UNIQUE (family, version)
);

CREATE OR REPLACE FUNCTION template.prevent_template_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = template, pg_catalog
AS $$
BEGIN
  IF NEW.states IS DISTINCT FROM OLD.states OR NEW.gates IS DISTINCT FROM OLD.gates THEN
    RAISE EXCEPTION
      'workflow_template % is immutable: states and gates cannot be changed after publish. '
      'Create a new version row instead.',
      OLD.template_id
      USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_workflow_template_immutable
  BEFORE UPDATE ON template.workflow_template
  FOR EACH ROW EXECUTE FUNCTION template.prevent_template_mutation();

CREATE INDEX IF NOT EXISTS idx_workflow_template_family_version
  ON template.workflow_template (family, version);

CREATE INDEX IF NOT EXISTS idx_workflow_template_lifecycle
  ON template.workflow_template (lifecycle_status);

-- ============================================================
-- 2. workflow_active schema — tenant snapshot table
-- Stores the full template row at pin time so orchestrators
-- can run without live cross-schema joins.
-- ============================================================
CREATE SCHEMA IF NOT EXISTS workflow_active;

CREATE TABLE IF NOT EXISTS workflow_active.workflow_template_copy (
  project_id           BIGINT      NOT NULL,
  template_id          TEXT        NOT NULL REFERENCES template.workflow_template(template_id)
                                   ON UPDATE RESTRICT ON DELETE RESTRICT,
  family               TEXT        NOT NULL,
  version              INT         NOT NULL,
  display_name         TEXT        NOT NULL,
  states               JSONB       NOT NULL,
  gates                JSONB       NOT NULL,
  pinned_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned_by_did        TEXT        NOT NULL DEFAULT 'system:migration',
  PRIMARY KEY (project_id, template_id)
);

COMMENT ON TABLE workflow_active.workflow_template_copy IS
  'Tenant snapshot of the template at pin time. Orchestrators read from here '
  'to avoid live cross-schema joins to template.workflow_template.';

CREATE INDEX IF NOT EXISTS idx_wact_copy_project
  ON workflow_active.workflow_template_copy (project_id);

-- ============================================================
-- 3. roadmap.project — add template_id FK column
-- ============================================================
ALTER TABLE roadmap.project
  ADD COLUMN IF NOT EXISTS template_id TEXT
    REFERENCES template.workflow_template(template_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ============================================================
-- 4. template_backfill_orphans — log unmatched projects
-- ============================================================
CREATE TABLE IF NOT EXISTS template.template_backfill_orphans (
  project_id     BIGINT      NOT NULL,
  project_slug   TEXT,
  detected_states TEXT[]     NOT NULL DEFAULT '{}',
  logged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes          TEXT,
  PRIMARY KEY (project_id)
);

COMMENT ON TABLE template.template_backfill_orphans IS
  'Projects whose proposal status history could not be matched to any known '
  'template family. Requires manual triage to assign template_id.';

-- ============================================================
-- 5. Seed built-in templates
-- owner_did = ''did:system:agenthive'' for all bootstrap rows
-- ============================================================

-- rfc-5-stage@v1 — Standard 5-stage RFC workflow
INSERT INTO template.workflow_template
  (template_id, family, version, display_name, description, states, gates, owner_did)
VALUES (
  'rfc-5-stage@v1',
  'rfc-5-stage',
  1,
  'Standard RFC 5-Stage',
  'Standard proposal lifecycle: Draft → Review → Develop → Merge → Complete.',
  '[
    {"name":"Draft",    "order":1},
    {"name":"Review",   "order":2},
    {"name":"Develop",  "order":3},
    {"name":"Merge",    "order":4},
    {"name":"Complete", "order":5}
  ]'::jsonb,
  '[
    {"from":"Draft",   "to":"Review",   "maturity_required":"mature"},
    {"from":"Review",  "to":"Develop",  "maturity_required":"mature"},
    {"from":"Review",  "to":"Draft",    "maturity_required":"any"},
    {"from":"Develop", "to":"Merge",    "maturity_required":"mature"},
    {"from":"Develop", "to":"Review",   "maturity_required":"any"},
    {"from":"Merge",   "to":"Complete", "maturity_required":"mature"},
    {"from":"Merge",   "to":"Develop",  "maturity_required":"any"}
  ]'::jsonb,
  'did:system:agenthive'
)
ON CONFLICT (template_id) DO NOTHING;

-- lightweight-3-stage@v1 — Simplified 3-stage workflow
INSERT INTO template.workflow_template
  (template_id, family, version, display_name, description, states, gates, owner_did)
VALUES (
  'lightweight-3-stage@v1',
  'lightweight-3-stage',
  1,
  'Lightweight 3-Stage',
  'Simplified workflow for low-complexity tasks: Draft → Develop → Complete.',
  '[
    {"name":"Draft",    "order":1},
    {"name":"Develop",  "order":2},
    {"name":"Complete", "order":3}
  ]'::jsonb,
  '[
    {"from":"Draft",   "to":"Develop",  "maturity_required":"mature"},
    {"from":"Develop", "to":"Complete", "maturity_required":"mature"},
    {"from":"Develop", "to":"Draft",    "maturity_required":"any"}
  ]'::jsonb,
  'did:system:agenthive'
)
ON CONFLICT (template_id) DO NOTHING;

-- ============================================================
-- 6. Backfill: assign template_id to existing projects
-- Inference: if ANY proposal in the project has used Review,
-- Develop, Merge, or Complete status → assign rfc-5-stage@v1.
-- Unmatched projects → template_backfill_orphans.
-- ============================================================

-- Projects with RFC-style states → assign rfc-5-stage@v1
UPDATE roadmap.project p
SET template_id = 'rfc-5-stage@v1'
WHERE p.template_id IS NULL
  AND EXISTS (
    SELECT 1 FROM roadmap_proposal.proposal pr
    WHERE pr.project_id = p.project_id
      AND pr.status IN ('Draft','Review','Develop','Merge','Complete')
  );

-- Log unmatched projects as orphans
INSERT INTO template.template_backfill_orphans (project_id, project_slug, detected_states, notes)
SELECT
  p.project_id,
  p.slug,
  COALESCE(
    ARRAY(
      SELECT DISTINCT pr.status
      FROM roadmap_proposal.proposal pr
      WHERE pr.project_id = p.project_id
    ),
    '{}'::TEXT[]
  ),
  'Backfill 070: no matching template found for detected proposal states'
FROM roadmap.project p
WHERE p.template_id IS NULL
ON CONFLICT (project_id) DO NOTHING;

COMMIT;
