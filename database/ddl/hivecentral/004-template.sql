-- ============================================================
-- P598 — hiveCentral.template schema
-- Immutable versioned workflow templates.
-- Once published, states/gates columns cannot be mutated.
-- New edits require a new version row (bump family+version).
-- ============================================================
-- Target DB:  hiveCentral
-- Depends on: none (self-contained schema)
-- ============================================================

CREATE SCHEMA IF NOT EXISTS template;

COMMENT ON SCHEMA template IS
  'Immutable versioned workflow templates. Each row is a published snapshot '
  'of a workflow definition identified by family + version. states and gates '
  'are frozen at publish time; edits require a new version row.';

-- ============================================================
-- template.workflow_template — the canonical template registry
-- template_id format: ^[a-z][a-z0-9-]*@v[1-9][0-9]*$
--   e.g.  rfc-5-stage@v1, hotfix@v2
-- family+version UNIQUE enforces one canonical row per bump.
-- states JSONB: array of stage objects
-- gates JSONB:  array of transition/gate objects
-- ============================================================
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

COMMENT ON TABLE template.workflow_template IS
  'Published workflow template versions. Immutable after insert: '
  'any attempt to change states or gates raises restrict_violation.';
COMMENT ON COLUMN template.workflow_template.template_id IS
  'Stable identifier combining family and version, e.g. rfc-5-stage@v1.';
COMMENT ON COLUMN template.workflow_template.family IS
  'Logical workflow family, e.g. "rfc-5-stage". All versions share a family.';
COMMENT ON COLUMN template.workflow_template.version IS
  'Monotonically increasing version within the family. Starts at 1.';
COMMENT ON COLUMN template.workflow_template.states IS
  'JSONB array of stage definitions. Frozen at publish time.';
COMMENT ON COLUMN template.workflow_template.gates IS
  'JSONB array of transition/gate definitions. Frozen at publish time.';

-- ============================================================
-- Immutability trigger — prevent states/gates mutation
-- Raises SQLSTATE 23001 (restrict_violation) on any attempt
-- to change states or gates after initial insert.
-- ============================================================
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
      USING ERRCODE = '23001'; -- restrict_violation
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION template.prevent_template_mutation() IS
  'Trigger guard: raises restrict_violation if states or gates are mutated after publish.';

CREATE OR REPLACE TRIGGER trg_workflow_template_immutable
  BEFORE UPDATE ON template.workflow_template
  FOR EACH ROW EXECUTE FUNCTION template.prevent_template_mutation();

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_workflow_template_family_version
  ON template.workflow_template (family, version);

CREATE INDEX IF NOT EXISTS idx_workflow_template_lifecycle
  ON template.workflow_template (lifecycle_status);

-- ============================================================
-- Grants (IF EXISTS pattern — roles may not exist in all envs)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_ro') THEN
    GRANT USAGE ON SCHEMA template TO roadmap_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA template TO roadmap_ro;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_rw') THEN
    GRANT USAGE ON SCHEMA template TO roadmap_rw;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA template TO roadmap_rw;
  END IF;
END $$;
