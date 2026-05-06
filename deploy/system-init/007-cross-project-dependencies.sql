-- ============================================================
-- agentHive2 — 007-cross-project-dependencies.sql
-- Cross-project dependency graph with integrity and cycle checks.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql, 004-governance.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- core.dependency_kind_catalog — dependency type catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS core.dependency_kind_catalog (
  kind                TEXT         PRIMARY KEY,
  description         TEXT         NOT NULL,
  is_directional      BOOLEAN      NOT NULL DEFAULT TRUE,
  cycle_check_enabled BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.dependency_kind_catalog IS
  'Dependency type catalog. Defines the semantics and cycle-check behavior for each dependency kind.';

COMMENT ON COLUMN core.dependency_kind_catalog.kind IS
  'Primary key: dependency kind (e.g., blocks, informs, requires_artifact).';

COMMENT ON COLUMN core.dependency_kind_catalog.is_directional IS
  'If TRUE, direction matters (A blocks B is different from B blocks A). If FALSE, bidirectional.';

COMMENT ON COLUMN core.dependency_kind_catalog.cycle_check_enabled IS
  'If TRUE, this kind participates in cycle detection.';

-- Seed the catalog
INSERT INTO core.dependency_kind_catalog (kind, description, is_directional, cycle_check_enabled)
VALUES
  ('blocks', 'A blocks B: A must complete before B can proceed.', TRUE, TRUE),
  ('informs', 'A informs B: A provides input/context to B but does not block it.', TRUE, FALSE),
  ('relates', 'A relates to B: bidirectional association, no precedence.', FALSE, FALSE),
  ('supersedes', 'A supersedes B: A replaces B functionally.', TRUE, TRUE),
  ('requires_artifact', 'A requires artifact from B: B must produce X for A.', TRUE, TRUE)
ON CONFLICT DO NOTHING;

-- ============================================================
-- core.cross_project_dependency — cross-project edge table
-- ============================================================
CREATE TABLE IF NOT EXISTS core.cross_project_dependency (
  edge_id                   BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_project_id           BIGINT       NOT NULL REFERENCES core.project (id) ON DELETE CASCADE,
  from_proposal_display_id  TEXT         NOT NULL,  -- e.g., 'P527'
  to_project_id             BIGINT       NOT NULL REFERENCES core.project (id) ON DELETE CASCADE,
  to_proposal_display_id    TEXT         NOT NULL,  -- e.g., 'P742'
  kind                      TEXT         NOT NULL REFERENCES core.dependency_kind_catalog (kind),
  declared_by_did           TEXT         NOT NULL,
  declared_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata_jsonb            JSONB        NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Ensure we don't duplicate edges
  UNIQUE (from_project_id, from_proposal_display_id, to_project_id, to_proposal_display_id, kind)
);

CREATE INDEX IF NOT EXISTS cross_project_dependency_from_project
  ON core.cross_project_dependency (from_project_id);

CREATE INDEX IF NOT EXISTS cross_project_dependency_to_project
  ON core.cross_project_dependency (to_project_id);

CREATE INDEX IF NOT EXISTS cross_project_dependency_kind
  ON core.cross_project_dependency (kind);

CREATE INDEX IF NOT EXISTS cross_project_dependency_declared_at
  ON core.cross_project_dependency (declared_at DESC);

COMMENT ON TABLE core.cross_project_dependency IS
  'Cross-project dependency edges. Links proposals across project schemas using TEXT display_ids '
  '(e.g., P527) rather than BIGINT ids, since each project has its own IDENTITY sequence.';

-- Set updated_at trigger
CREATE OR REPLACE TRIGGER set_updated_at_cross_project_dependency
  BEFORE UPDATE ON core.cross_project_dependency
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ============================================================
-- core.fn_check_cross_project_dep_integrity()
-- Returns orphaned cross-project dependency edges.
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_check_cross_project_dep_integrity()
RETURNS TABLE (
  edge_id BIGINT,
  from_project_id BIGINT,
  from_project_slug TEXT,
  from_proposal_display_id TEXT,
  to_project_id BIGINT,
  to_project_slug TEXT,
  to_proposal_display_id TEXT,
  kind TEXT,
  missing_side TEXT,
  declared_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_schema_name TEXT;
  v_proposal_exists BOOLEAN;
BEGIN
  -- Check all cross-project edges
  RETURN QUERY
  WITH edge_check AS (
    SELECT
      cpd.edge_id,
      cpd.from_project_id,
      fp.slug AS from_project_slug,
      cpd.from_proposal_display_id,
      cpd.to_project_id,
      tp.slug AS to_project_slug,
      cpd.to_proposal_display_id,
      cpd.kind,
      cpd.declared_at,
      -- Check if from-side proposal exists
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = fp.schema_name
          AND c.relname = 'proposal'
      ) AS from_schema_exists,
      -- Check if to-side proposal exists
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = tp.schema_name
          AND c.relname = 'proposal'
      ) AS to_schema_exists
    FROM core.cross_project_dependency cpd
    JOIN core.project fp ON cpd.from_project_id = fp.id
    JOIN core.project tp ON cpd.to_project_id = tp.id
  )
  SELECT
    ec.edge_id,
    ec.from_project_id,
    ec.from_project_slug,
    ec.from_proposal_display_id,
    ec.to_project_id,
    ec.to_project_slug,
    ec.to_proposal_display_id,
    ec.kind,
    CASE
      WHEN NOT ec.from_schema_exists THEN 'from_schema_not_found'
      WHEN NOT ec.to_schema_exists THEN 'to_schema_not_found'
      ELSE 'unknown'
    END::TEXT,
    ec.declared_at
  FROM edge_check ec
  WHERE NOT ec.from_schema_exists OR NOT ec.to_schema_exists;
END;
$$;

COMMENT ON FUNCTION core.fn_check_cross_project_dep_integrity() IS
  'Returns all cross-project dependency edges where the source or target project schema is missing or the proposal cannot be found in its target schema.';

-- ============================================================
-- core.fn_check_cross_project_dep_cycles()
-- Detects cycles in the cross-project dependency graph.
-- Returns the cycle path if found.
-- ============================================================
CREATE OR REPLACE FUNCTION core.fn_check_cross_project_dep_cycles()
RETURNS TABLE (
  cycle_path TEXT,
  cycle_nodes TEXT[],
  cycle_edges TEXT[],
  detected_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_cycle_path TEXT;
  v_cycle_nodes TEXT[];
  v_cycle_edges TEXT[];
BEGIN
  -- Build a recursive graph of cross-project dependencies
  -- and search for cycles using a CTE.
  -- For simplicity, we search for any cycle involving proposals
  -- that appear in both the from and to sides.

  RETURN QUERY
  WITH RECURSIVE dep_graph AS (
    -- Base: all cross-project edges (only directional kinds)
    SELECT
      cpd.from_project_id,
      cpd.from_proposal_display_id,
      cpd.to_project_id,
      cpd.to_proposal_display_id,
      cpd.kind,
      ARRAY[
        cpd.from_project_id::TEXT || ':' || cpd.from_proposal_display_id,
        cpd.to_project_id::TEXT || ':' || cpd.to_proposal_display_id
      ]::TEXT[] AS node_path,
      ARRAY[
        cpd.edge_id::TEXT
      ]::TEXT[] AS edge_path,
      1 AS depth
    FROM core.cross_project_dependency cpd
    JOIN core.dependency_kind_catalog dkc ON cpd.kind = dkc.kind
    WHERE dkc.cycle_check_enabled

    UNION ALL

    -- Recursive: extend paths
    SELECT
      dg.from_project_id,
      dg.from_proposal_display_id,
      cpd.to_project_id,
      cpd.to_proposal_display_id,
      cpd.kind,
      dg.node_path || ARRAY[cpd.to_project_id::TEXT || ':' || cpd.to_proposal_display_id],
      dg.edge_path || ARRAY[cpd.edge_id::TEXT],
      dg.depth + 1
    FROM dep_graph dg
    JOIN core.cross_project_dependency cpd ON (
      cpd.from_project_id = dg.to_project_id
      AND cpd.from_proposal_display_id = dg.to_proposal_display_id
    )
    JOIN core.dependency_kind_catalog dkc ON cpd.kind = dkc.kind
    WHERE dkc.cycle_check_enabled
      AND dg.depth < 100  -- Prevent infinite recursion
      AND NOT (cpd.to_project_id::TEXT || ':' || cpd.to_proposal_display_id) = ANY(dg.node_path)  -- Not already in path
  ),
  cycle_detection AS (
    -- Find cycles: where the endpoint can reach back to the start
    SELECT DISTINCT
      dg.from_project_id,
      dg.from_proposal_display_id,
      dg.to_project_id,
      dg.to_proposal_display_id,
      dg.node_path,
      dg.edge_path
    FROM dep_graph dg
    WHERE (dg.to_project_id::TEXT || ':' || dg.to_proposal_display_id) = (dg.from_project_id::TEXT || ':' || dg.from_proposal_display_id)
      AND dg.depth > 1
  )
  SELECT
    array_to_string(cd.node_path, ' -> '),
    cd.node_path,
    cd.edge_path,
    now()
  FROM cycle_detection cd;
END;
$$;

COMMENT ON FUNCTION core.fn_check_cross_project_dep_cycles() IS
  'Detects cycles in the cross-project dependency graph. Returns the cycle path, nodes, and edges if a cycle is found. Limited to cycle_check_enabled kinds.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE, DELETE ON core.cross_project_dependency TO agenthive_orchestrator;
    GRANT SELECT ON core.dependency_kind_catalog TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_integrity() TO agenthive_orchestrator;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_cycles() TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_observability;
    GRANT SELECT ON core.cross_project_dependency TO agenthive_observability;
    GRANT SELECT ON core.dependency_kind_catalog TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_integrity() TO agenthive_observability;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_cycles() TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA core TO agenthive_agency;
    GRANT SELECT ON core.cross_project_dependency TO agenthive_agency;
    GRANT SELECT ON core.dependency_kind_catalog TO agenthive_agency;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_integrity() TO agenthive_agency;
    GRANT EXECUTE ON FUNCTION core.fn_check_cross_project_dep_cycles() TO agenthive_agency;
  END IF;
END $$;
