-- Migration 122: P997 — proposal_migration_map schema
--
-- Defines the structured mapping artifact from legacy proposal rows to
-- their canonical agentHive2 documentation-shaped stack nodes.
-- This table is a control-plane projection helper and does NOT replace the
-- proposal lifecycle source of truth (proposal, proposal_state_transitions,
-- gate_decision_log, proposal_discussions).

BEGIN;

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_migration_map (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_proposal_id        TEXT   NOT NULL UNIQUE,
  legacy_proposal_row_id    BIGINT REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  canonical_proposal_id     TEXT,
  canonical_proposal_row_id BIGINT REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  classification            TEXT   NOT NULL
    CHECK (classification IN (
      'retained', 'delivered_evidence', 'duplicate',
      'obsolete', 'reauthor_needed', 'superseded'
    )),
  rationale                 TEXT   NOT NULL
    CHECK (length(TRIM(BOTH FROM rationale)) > 0),
  evidence_refs             JSONB  NOT NULL DEFAULT '[]',
  superseded_by_proposal_id TEXT,
  superseded_by_row_id      BIGINT REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  reviewed_by               TEXT,
  reviewed_at               TIMESTAMPTZ,
  created_by                TEXT   NOT NULL DEFAULT 'system',
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_proposal.proposal_migration_map IS
  'Control-plane projection helper mapping legacy proposals to agentHive2 canonical nodes. '
  'Does NOT replace the proposal lifecycle source of truth: proposal, proposal_state_transitions, '
  'gate_decision_log, or proposal_discussions. Agents must update both the mapping row (this table) '
  'and the proposal maturity (set_maturity=obsolete) independently.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.legacy_proposal_id IS
  'Display ID of the legacy proposal (e.g. ''P42''). Text anchor that survives row deletion. Always populated.';
COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.classification IS
  'P995 vocabulary: retained | delivered_evidence | duplicate | obsolete | reauthor_needed | superseded.';
COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.evidence_refs IS
  'JSONB array of reference objects: [{type, ref, label?}]. '
  'Accepted types: commit, ac_id, discussion_id, doc_slug, migration_id, review_id, external_url.';

-- ── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pmm_legacy_row
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_row_id)
  WHERE legacy_proposal_row_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_canonical_row
  ON roadmap_proposal.proposal_migration_map (canonical_proposal_row_id)
  WHERE canonical_proposal_row_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_delivered_evidence
  ON roadmap_proposal.proposal_migration_map (canonical_proposal_id)
  WHERE classification = 'delivered_evidence';

CREATE INDEX IF NOT EXISTS idx_pmm_dup_superseded
  ON roadmap_proposal.proposal_migration_map (classification)
  WHERE classification IN ('duplicate', 'superseded');

CREATE INDEX IF NOT EXISTS idx_pmm_unresolved
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
  WHERE reviewed_by IS NULL OR reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_incomplete
  ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
  WHERE reviewed_by IS NULL OR evidence_refs = '[]';

CREATE INDEX IF NOT EXISTS idx_pmm_superseded_by
  ON roadmap_proposal.proposal_migration_map (superseded_by_row_id)
  WHERE superseded_by_row_id IS NOT NULL;

-- ── Updated-at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_set_migration_map_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_migration_map_updated_at'
      AND tgrelid = 'roadmap_proposal.proposal_migration_map'::regclass
  ) THEN
    CREATE TRIGGER trg_migration_map_updated_at
      BEFORE UPDATE ON roadmap_proposal.proposal_migration_map
      FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_set_migration_map_updated_at();
  END IF;
END;
$$;

-- ── Views ──────────────────────────────────────────────────────────────────

-- Rows where reviewer, timestamp, or canonical target is missing
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_unresolved AS
  SELECT
    id, legacy_proposal_id, legacy_proposal_row_id, classification,
    rationale, evidence_refs, canonical_proposal_id,
    reviewed_by, reviewed_at, created_at, updated_at,
    CASE
      WHEN reviewed_by IS NULL THEN 'missing_reviewer'
      WHEN reviewed_at IS NULL THEN 'missing_reviewed_at'
      WHEN canonical_proposal_id IS NULL
           AND classification NOT IN ('obsolete', 'duplicate') THEN 'missing_canonical_id'
      WHEN classification IN ('superseded', 'duplicate')
           AND superseded_by_proposal_id IS NULL THEN 'missing_superseded_by'
      ELSE 'unresolved'
    END AS unresolved_reason
  FROM roadmap_proposal.proposal_migration_map m
  WHERE reviewed_by IS NULL
     OR reviewed_at IS NULL
     OR (canonical_proposal_id IS NULL
         AND classification NOT IN ('obsolete', 'duplicate'))
     OR (classification IN ('superseded', 'duplicate')
         AND superseded_by_proposal_id IS NULL);

COMMENT ON VIEW roadmap_proposal.v_migration_unresolved IS
  'Rows missing reviewer, timestamp, canonical ID (non-obsolete/duplicate), or superseded_by (dup/superseded). '
  'Projection helper — does NOT replace proposal lifecycle tables.';

-- Duplicate / superseded cluster with replacement chain
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_dup_superseded AS
  SELECT
    id, legacy_proposal_id, legacy_proposal_row_id, classification, rationale,
    superseded_by_proposal_id, superseded_by_row_id, evidence_refs,
    reviewed_by, reviewed_at,
    canonical_proposal_id AS replacement_canonical_id,
    canonical_proposal_row_id AS replacement_canonical_row_id
  FROM roadmap_proposal.proposal_migration_map m
  WHERE classification IN ('duplicate', 'superseded')
  ORDER BY classification, legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_dup_superseded IS
  'Duplicate and superseded mapping rows with their replacement chain. '
  'Projection helper — does NOT replace proposal lifecycle tables.';

-- Delivered evidence (COMPLETE proposals with verified ACs)
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_delivered_evidence AS
  SELECT
    id, legacy_proposal_id, legacy_proposal_row_id, canonical_proposal_id,
    canonical_proposal_row_id, rationale, evidence_refs, reviewed_by, reviewed_at,
    jsonb_array_length(evidence_refs) AS evidence_ref_count,
    (evidence_refs = '[]') AS evidence_missing
  FROM roadmap_proposal.proposal_migration_map m
  WHERE classification = 'delivered_evidence'
  ORDER BY legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_delivered_evidence IS
  'Delivered-evidence mappings with evidence reference count and missing-evidence flag. '
  'Projection helper — does NOT replace proposal lifecycle tables.';

-- Rows missing reviewer, timestamp, evidence, or canonical_id
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_incomplete AS
  SELECT
    id, legacy_proposal_id, legacy_proposal_row_id, classification,
    reviewed_by, reviewed_at,
    (evidence_refs = '[]')                                            AS evidence_missing,
    (reviewed_by IS NULL)                                             AS reviewer_missing,
    (reviewed_at IS NULL)                                             AS timestamp_missing,
    (canonical_proposal_id IS NULL
     AND classification NOT IN ('obsolete', 'duplicate'))            AS canonical_missing,
    notes, updated_at
  FROM roadmap_proposal.proposal_migration_map m
  WHERE reviewed_by IS NULL
     OR reviewed_at IS NULL
     OR evidence_refs = '[]'
     OR (canonical_proposal_id IS NULL
         AND classification NOT IN ('obsolete', 'duplicate'))
  ORDER BY legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_migration_incomplete IS
  'Rows with per-column boolean gap flags for reviewer, timestamp, evidence refs, and canonical ID. '
  'Projection helper — does NOT replace proposal lifecycle tables.';

-- Classification roll-up summary
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_classification_summary AS
  SELECT
    classification,
    count(*)                                                            AS total,
    count(*) FILTER (WHERE reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL) AS reviewed,
    count(*) FILTER (WHERE reviewed_by IS NULL OR reviewed_at IS NULL)          AS unreviewed,
    count(*) FILTER (WHERE evidence_refs <> '[]')                               AS with_evidence,
    count(*) FILTER (WHERE evidence_refs = '[]')                                AS without_evidence,
    count(*) FILTER (WHERE canonical_proposal_id IS NOT NULL)                   AS with_canonical
  FROM roadmap_proposal.proposal_migration_map
  GROUP BY classification
  ORDER BY classification;

COMMENT ON VIEW roadmap_proposal.v_migration_classification_summary IS
  'Roll-up counts by classification — total, reviewed, unreviewed, with/without evidence, with canonical. '
  'Projection helper — does NOT replace proposal lifecycle tables.';

-- ── Migration history record ────────────────────────────────────────────────

INSERT INTO roadmap.migration_history (filename, checksum_sha256, applied_by, environment, status)
VALUES (
  '122-p997-proposal-migration-map.sql',
  'p997-proposal-migration-map-schema-views',
  'P997-developer-alan',
  'development',
  'applied'
)
ON CONFLICT (filename) DO UPDATE
  SET status     = 'applied',
      applied_at = now()
  WHERE roadmap.migration_history.applied_at IS NULL;

COMMIT;
