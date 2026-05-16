-- P997: legacy-to-agentHive2 proposal mapping artifact schema
--
-- Adds roadmap_proposal.proposal_migration_map and four query views that let
-- agents classify legacy proposals, track review state, and generate
-- documentation projections for the P995 agentHive2 re-authoring effort.
--
-- Design notes:
--   • This table is a CONTROL-PLANE HELPER / PROJECTION ARTIFACT.
--     It does NOT replace the proposal lifecycle source of truth, which
--     remains: proposal, proposal_state_transitions, proposal_acceptance_criteria,
--     gate_decision_log, and proposal_discussions.
--   • Mapping rows survive even if the legacy proposal row is deleted
--     (legacy_proposal_row_id FK is ON DELETE SET NULL, legacy_proposal_id TEXT
--     is the durable anchor).
--   • Classification vocabulary matches P995 exactly:
--       retained | delivered_evidence | duplicate | obsolete | reauthor_needed | superseded
--   • evidence_refs is JSONB array of {type, ref, label?} to support mixed
--     reference kinds (commits, AC IDs, discussion IDs, doc slugs, migration IDs).
--   • Large-scale population is owned by the P995 inventory child, not here.
--     This migration only creates the schema; initial rows are seeded by agents.
--
-- Target DB:  agenthive (roadmap_proposal schema)
-- Depends on: roadmap_proposal.proposal (exists in all deployed envs)
-- Next migration: 123+

BEGIN;

-- ============================================================
-- Table: proposal_migration_map
-- ============================================================
CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_migration_map (
  id                          BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Durable text anchor — display_id like 'P123'.
  -- Never NULL. Survives row deletion of the legacy proposal.
  legacy_proposal_id          TEXT         NOT NULL,

  -- Optional FK to the live proposal row; SET NULL on delete so the
  -- mapping record remains as a permanent audit artifact.
  legacy_proposal_row_id      BIGINT       NULL
                              REFERENCES roadmap_proposal.proposal (id)
                              ON DELETE SET NULL,

  -- agentHive2 canonical stack node.  NULL when classification=obsolete
  -- (no canonical equivalent) or when mapping is still unreviewed.
  canonical_proposal_id       TEXT         NULL,
  canonical_proposal_row_id   BIGINT       NULL
                              REFERENCES roadmap_proposal.proposal (id)
                              ON DELETE SET NULL,

  -- P995 classification vocabulary (exact match required).
  classification              TEXT         NOT NULL
                              CHECK (classification IN (
                                'retained',           -- kept as-is; valid agentHive2 node
                                'delivered_evidence', -- completed + verified ACs; preserved as evidence
                                'duplicate',          -- near-exact duplicate of another proposal
                                'obsolete',           -- no agentHive2 equivalent; structural change made it moot
                                'reauthor_needed',    -- too stale/noisy; needs new canonical parent
                                'superseded'          -- explicitly replaced by another proposal
                              )),

  -- Non-empty explanation of why this classification was chosen.
  rationale                   TEXT         NOT NULL
                              CHECK (length(trim(rationale)) > 0),

  -- Flexible evidence references.  Each element should be an object with
  -- at least {type, ref}; optional label field for human display.
  -- Supported types: commit | ac_id | discussion_id | doc_slug |
  --                  migration_id | review_id | external_url
  evidence_refs               JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- When classification IN ('superseded', 'duplicate'), this identifies
  -- which canonical proposal takes over.
  superseded_by_proposal_id   TEXT         NULL,
  superseded_by_row_id        BIGINT       NULL
                              REFERENCES roadmap_proposal.proposal (id)
                              ON DELETE SET NULL,

  -- Review provenance.  Both NULL → unreviewed.
  reviewed_by                 TEXT         NULL,  -- agent_identity or reviewer DID/handle
  reviewed_at                 TIMESTAMPTZ  NULL,

  -- Housekeeping
  created_by                  TEXT         NOT NULL DEFAULT 'system',
  notes                       TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- One canonical mapping row per legacy proposal.
  UNIQUE (legacy_proposal_id)
);

COMMENT ON TABLE roadmap_proposal.proposal_migration_map IS
  'Control-plane helper that records how each legacy AgentHive proposal maps '
  'to the agentHive2 documentation-shaped proposal stack (P995/P997). '
  'This is a projection artifact — it does NOT replace the proposal lifecycle '
  'source of truth (proposal, proposal_state_transitions, gate_decision_log, '
  'proposal_discussions). legacy_proposal_id is the durable string anchor; '
  'FKs are nullable so rows survive legacy row deletion.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.legacy_proposal_id IS
  'Display ID of the legacy proposal (e.g. ''P42''). Text anchor that survives '
  'row deletion. Always populated.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.classification IS
  'P995 vocabulary: retained | delivered_evidence | duplicate | obsolete | '
  'reauthor_needed | superseded.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.evidence_refs IS
  'JSONB array of reference objects: [{type, ref, label?}]. '
  'Accepted types: commit, ac_id, discussion_id, doc_slug, migration_id, '
  'review_id, external_url.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.superseded_by_proposal_id IS
  'Display ID of the proposal that replaces this one. '
  'Required when classification=superseded or duplicate.';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_set_migration_map_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_migration_map_updated_at
  BEFORE UPDATE ON roadmap_proposal.proposal_migration_map
  FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_set_migration_map_updated_at();

-- ============================================================
-- Indexes — targeted at the four query surfaces in P997 AC-3
-- ============================================================

-- Unresolved: rows where review is incomplete
CREATE INDEX IF NOT EXISTS idx_pmm_unresolved
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
  WHERE reviewed_by IS NULL OR reviewed_at IS NULL;

-- Duplicate / superseded family
CREATE INDEX IF NOT EXISTS idx_pmm_dup_superseded
  ON roadmap_proposal.proposal_migration_map (classification)
  WHERE classification IN ('duplicate', 'superseded');

-- Delivered evidence lookups (common for documentation projection)
CREATE INDEX IF NOT EXISTS idx_pmm_delivered_evidence
  ON roadmap_proposal.proposal_migration_map (canonical_proposal_id)
  WHERE classification = 'delivered_evidence';

-- Incomplete rationale / evidence
CREATE INDEX IF NOT EXISTS idx_pmm_incomplete
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
  WHERE reviewed_by IS NULL
     OR evidence_refs = '[]'::jsonb;

-- Fast FK lookups
CREATE INDEX IF NOT EXISTS idx_pmm_legacy_row
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_row_id)
  WHERE legacy_proposal_row_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_canonical_row
  ON roadmap_proposal.proposal_migration_map (canonical_proposal_row_id)
  WHERE canonical_proposal_row_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_superseded_by
  ON roadmap_proposal.proposal_migration_map (superseded_by_row_id)
  WHERE superseded_by_row_id IS NOT NULL;

-- ============================================================
-- View 1: v_migration_unresolved
-- All mapping rows that are not yet fully reviewed.
-- "Unresolved" = missing reviewer OR missing timestamp OR
--                has no canonical_proposal_id for non-obsolete rows.
-- ============================================================
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_unresolved AS
SELECT
  m.id,
  m.legacy_proposal_id,
  m.legacy_proposal_row_id,
  m.classification,
  m.rationale,
  m.evidence_refs,
  m.canonical_proposal_id,
  m.reviewed_by,
  m.reviewed_at,
  m.created_at,
  m.updated_at,
  -- Reason this row is considered unresolved (first matched reason wins)
  CASE
    WHEN m.reviewed_by IS NULL                                      THEN 'missing_reviewer'
    WHEN m.reviewed_at IS NULL                                      THEN 'missing_reviewed_at'
    WHEN m.canonical_proposal_id IS NULL
         AND m.classification NOT IN ('obsolete', 'duplicate')      THEN 'missing_canonical_id'
    WHEN m.classification IN ('superseded', 'duplicate')
         AND m.superseded_by_proposal_id IS NULL                    THEN 'missing_superseded_by'
    ELSE 'unresolved'
  END AS unresolved_reason
FROM roadmap_proposal.proposal_migration_map m
WHERE m.reviewed_by IS NULL
   OR m.reviewed_at IS NULL
   OR (m.canonical_proposal_id IS NULL AND m.classification NOT IN ('obsolete', 'duplicate'))
   OR (m.classification IN ('superseded', 'duplicate') AND m.superseded_by_proposal_id IS NULL);

COMMENT ON VIEW roadmap_proposal.v_migration_unresolved IS
  'Mapping rows that are incomplete: missing reviewer, timestamp, canonical '
  'proposal ID (for non-obsolete/non-duplicate), or superseded_by link.';

-- ============================================================
-- View 2: v_migration_dup_superseded
-- All duplicate and superseded mappings with their replacement chain.
-- ============================================================
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_dup_superseded AS
SELECT
  m.id,
  m.legacy_proposal_id,
  m.legacy_proposal_row_id,
  m.classification,
  m.rationale,
  m.superseded_by_proposal_id,
  m.superseded_by_row_id,
  m.evidence_refs,
  m.reviewed_by,
  m.reviewed_at,
  -- Canonical proposal of the superseding node (one hop)
  m.canonical_proposal_id        AS replacement_canonical_id,
  m.canonical_proposal_row_id    AS replacement_canonical_row_id
FROM roadmap_proposal.proposal_migration_map m
WHERE m.classification IN ('duplicate', 'superseded')
ORDER BY m.classification, m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_dup_superseded IS
  'Duplicate and superseded mapping rows with their replacement chain. '
  'Used to generate explicit superseded-by notes before setting maturity=obsolete.';

-- ============================================================
-- View 3: v_migration_delivered_evidence
-- All proposals classified as delivered_evidence with their evidence links.
-- Primary input for documentation projection of completed work inventory.
-- ============================================================
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_delivered_evidence AS
SELECT
  m.id,
  m.legacy_proposal_id,
  m.legacy_proposal_row_id,
  m.canonical_proposal_id,
  m.canonical_proposal_row_id,
  m.rationale,
  m.evidence_refs,
  m.reviewed_by,
  m.reviewed_at,
  -- Convenience: count of evidence references provided
  jsonb_array_length(m.evidence_refs) AS evidence_ref_count,
  -- Flag rows where evidence refs are empty (needs follow-up)
  (m.evidence_refs = '[]'::jsonb)     AS evidence_missing
FROM roadmap_proposal.proposal_migration_map m
WHERE m.classification = 'delivered_evidence'
ORDER BY m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_delivered_evidence IS
  'Completed proposals preserved as delivered evidence. Used to populate '
  'the agentHive2 Completed Work Inventory documentation section.';

-- ============================================================
-- View 4: v_migration_incomplete
-- Rows missing reviewer, rationale detail, or evidence references.
-- Used for quality-gating before documentation projection runs.
-- ============================================================
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_incomplete AS
SELECT
  m.id,
  m.legacy_proposal_id,
  m.legacy_proposal_row_id,
  m.classification,
  m.reviewed_by,
  m.reviewed_at,
  (m.evidence_refs = '[]'::jsonb)         AS evidence_missing,
  (m.reviewed_by IS NULL)                 AS reviewer_missing,
  (m.reviewed_at IS NULL)                 AS timestamp_missing,
  (m.canonical_proposal_id IS NULL
   AND m.classification NOT IN ('obsolete', 'duplicate')) AS canonical_missing,
  m.notes,
  m.updated_at
FROM roadmap_proposal.proposal_migration_map m
WHERE m.reviewed_by IS NULL
   OR m.reviewed_at IS NULL
   OR m.evidence_refs = '[]'::jsonb
   OR (m.canonical_proposal_id IS NULL AND m.classification NOT IN ('obsolete', 'duplicate'))
ORDER BY m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_incomplete IS
  'Mapping rows that have gaps in reviewer, timestamp, evidence, or canonical '
  'proposal ID. Quality gate before documentation projection can run.';

-- ============================================================
-- Summary view: v_migration_classification_summary
-- Roll-up counts by classification for dashboard / agent reports.
-- ============================================================
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_classification_summary AS
SELECT
  classification,
  COUNT(*)                                                    AS total,
  COUNT(*) FILTER (WHERE reviewed_by IS NOT NULL
                     AND reviewed_at IS NOT NULL)             AS reviewed,
  COUNT(*) FILTER (WHERE reviewed_by IS NULL
                      OR reviewed_at IS NULL)                 AS unreviewed,
  COUNT(*) FILTER (WHERE evidence_refs <> '[]'::jsonb)        AS with_evidence,
  COUNT(*) FILTER (WHERE evidence_refs = '[]'::jsonb)         AS without_evidence,
  COUNT(*) FILTER (WHERE canonical_proposal_id IS NOT NULL)   AS with_canonical
FROM roadmap_proposal.proposal_migration_map
GROUP BY classification
ORDER BY classification;

COMMENT ON VIEW roadmap_proposal.v_migration_classification_summary IS
  'Roll-up counts by classification for agent reports and operator dashboards. '
  'Columns: total, reviewed, unreviewed, with/without evidence, with_canonical.';

-- ============================================================
-- Grants — match existing roadmap_proposal grant pattern
-- ============================================================
DO $$
BEGIN
  -- agenthive_orchestrator: full rw (runs the inventory agent)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON roadmap_proposal.proposal_migration_map TO agenthive_orchestrator;
    GRANT SELECT ON roadmap_proposal.v_migration_unresolved TO agenthive_orchestrator;
    GRANT SELECT ON roadmap_proposal.v_migration_dup_superseded TO agenthive_orchestrator;
    GRANT SELECT ON roadmap_proposal.v_migration_delivered_evidence TO agenthive_orchestrator;
    GRANT SELECT ON roadmap_proposal.v_migration_incomplete TO agenthive_orchestrator;
    GRANT SELECT ON roadmap_proposal.v_migration_classification_summary TO agenthive_orchestrator;
  END IF;

  -- agenthive_observability / roadmap read roles: read-only
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT SELECT ON roadmap_proposal.proposal_migration_map TO agenthive_observability;
    GRANT SELECT ON roadmap_proposal.v_migration_unresolved TO agenthive_observability;
    GRANT SELECT ON roadmap_proposal.v_migration_dup_superseded TO agenthive_observability;
    GRANT SELECT ON roadmap_proposal.v_migration_delivered_evidence TO agenthive_observability;
    GRANT SELECT ON roadmap_proposal.v_migration_incomplete TO agenthive_observability;
    GRANT SELECT ON roadmap_proposal.v_migration_classification_summary TO agenthive_observability;
  END IF;

  -- agenthive_agency: rw so inventory agents can INSERT/UPDATE mapping rows
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT SELECT, INSERT, UPDATE
      ON roadmap_proposal.proposal_migration_map TO agenthive_agency;
    GRANT SELECT ON roadmap_proposal.v_migration_unresolved TO agenthive_agency;
    GRANT SELECT ON roadmap_proposal.v_migration_dup_superseded TO agenthive_agency;
    GRANT SELECT ON roadmap_proposal.v_migration_delivered_evidence TO agenthive_agency;
    GRANT SELECT ON roadmap_proposal.v_migration_incomplete TO agenthive_agency;
    GRANT SELECT ON roadmap_proposal.v_migration_classification_summary TO agenthive_agency;
  END IF;
END $$;

-- ============================================================
-- Migration history record
-- ============================================================
INSERT INTO roadmap.migration_history (filename, checksum_sha256, applied_by, environment, status)
VALUES (
  '122-p997-proposal-migration-map.sql',
  md5('122-p997-proposal-migration-map')::text,   -- placeholder; CI replaces with actual sha256
  current_user,
  current_database(),
  'applied'
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;
