-- P997: legacy-to-agentHive2 proposal mapping artifact schema
-- Maps every legacy proposal row to its canonical agentHive2 stack node.
-- This table is a projection/control-plane helper; it does NOT replace
-- the proposal lifecycle source of truth in roadmap.proposals.

CREATE TABLE IF NOT EXISTS roadmap.proposal_legacy_mapping (
  id                       SERIAL PRIMARY KEY,
  legacy_proposal_id       TEXT        NOT NULL,
  canonical_proposal_id    TEXT        NULL,          -- NULL when no canonical node exists yet
  classification           TEXT        NOT NULL,
  rationale                TEXT        NOT NULL,
  evidence_refs            JSONB       NOT NULL DEFAULT '[]',
  superseded_by_proposal_id TEXT       NULL,
  reviewed_by              TEXT        NULL,
  reviewed_at              TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plm_classification_values CHECK (
    classification IN (
      'retained',          -- legacy proposal is the canonical node; keep as-is
      'delivered_evidence',-- COMPLETE with verified ACs; linked as evidence under a new parent
      'duplicate',         -- duplicate of another proposal; superseded_by_proposal_id required
      'obsolete',          -- no longer relevant; may or may not have a superseded_by
      'reauthor_needed',   -- too stale/noisy to serve as implementation record; new proposal needed
      'superseded'         -- explicitly replaced by superseded_by_proposal_id
    )
  ),
  CONSTRAINT plm_superseded_requires_link CHECK (
    classification NOT IN ('duplicate', 'superseded') OR superseded_by_proposal_id IS NOT NULL
  ),
  CONSTRAINT plm_legacy_id_unique UNIQUE (legacy_proposal_id)
);

COMMENT ON TABLE roadmap.proposal_legacy_mapping IS
  'P997: Maps legacy proposal IDs to canonical agentHive2 stack nodes. '
  'Source of truth for migration classification; NOT a replacement for roadmap.proposals lifecycle state.';

COMMENT ON COLUMN roadmap.proposal_legacy_mapping.classification IS
  'retained | delivered_evidence | duplicate | obsolete | reauthor_needed | superseded';

COMMENT ON COLUMN roadmap.proposal_legacy_mapping.evidence_refs IS
  'JSON array of reference objects: [{type: "proposal"|"commit"|"ac"|"review"|"migration"|"discussion", ref: "..."}]';

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION roadmap.fn_plm_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_plm_updated_at ON roadmap.proposal_legacy_mapping;
CREATE TRIGGER trg_plm_updated_at
  BEFORE UPDATE ON roadmap.proposal_legacy_mapping
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_plm_updated_at();

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_plm_canonical_proposal
  ON roadmap.proposal_legacy_mapping (canonical_proposal_id)
  WHERE canonical_proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plm_classification
  ON roadmap.proposal_legacy_mapping (classification);

CREATE INDEX IF NOT EXISTS idx_plm_unreviewed
  ON roadmap.proposal_legacy_mapping (created_at)
  WHERE reviewed_by IS NULL;

-- View: unresolved mappings (no canonical node or no reviewer)
CREATE OR REPLACE VIEW roadmap.v_plm_unresolved AS
SELECT
  id, legacy_proposal_id, classification, rationale,
  canonical_proposal_id, superseded_by_proposal_id,
  reviewed_by, reviewed_at, created_at
FROM roadmap.proposal_legacy_mapping
WHERE canonical_proposal_id IS NULL
   OR reviewed_by IS NULL
ORDER BY created_at;

-- View: duplicate and superseded mappings
CREATE OR REPLACE VIEW roadmap.v_plm_superseded AS
SELECT
  id, legacy_proposal_id, classification,
  superseded_by_proposal_id, rationale,
  reviewed_by, reviewed_at
FROM roadmap.proposal_legacy_mapping
WHERE classification IN ('duplicate', 'superseded')
ORDER BY superseded_by_proposal_id, legacy_proposal_id;

-- View: delivered evidence grouped by canonical proposal
CREATE OR REPLACE VIEW roadmap.v_plm_delivered_evidence AS
SELECT
  canonical_proposal_id,
  COUNT(*) AS evidence_count,
  ARRAY_AGG(legacy_proposal_id ORDER BY legacy_proposal_id) AS legacy_ids,
  JSONB_AGG(evidence_refs) AS all_evidence_refs
FROM roadmap.proposal_legacy_mapping
WHERE classification = 'delivered_evidence'
  AND canonical_proposal_id IS NOT NULL
GROUP BY canonical_proposal_id
ORDER BY canonical_proposal_id;

-- View: mappings missing reviewer or rationale (data-quality check)
CREATE OR REPLACE VIEW roadmap.v_plm_incomplete AS
SELECT
  id, legacy_proposal_id, classification,
  canonical_proposal_id, rationale,
  reviewed_by, reviewed_at
FROM roadmap.proposal_legacy_mapping
WHERE reviewed_by IS NULL
   OR rationale IS NULL
   OR rationale = ''
ORDER BY created_at;

-- View: classification summary counts
CREATE OR REPLACE VIEW roadmap.v_plm_summary AS
SELECT
  classification,
  COUNT(*) AS count,
  COUNT(*) FILTER (WHERE reviewed_by IS NOT NULL) AS reviewed_count,
  COUNT(*) FILTER (WHERE reviewed_by IS NULL) AS unreviewed_count
FROM roadmap.proposal_legacy_mapping
GROUP BY classification
ORDER BY classification;

-- Grants
GRANT SELECT ON roadmap.proposal_legacy_mapping TO roadmap_ro;
GRANT SELECT, INSERT, UPDATE ON roadmap.proposal_legacy_mapping TO roadmap_app;
GRANT USAGE ON SEQUENCE roadmap.proposal_legacy_mapping_id_seq TO roadmap_app;
GRANT SELECT ON roadmap.v_plm_unresolved TO roadmap_ro;
GRANT SELECT ON roadmap.v_plm_superseded TO roadmap_ro;
GRANT SELECT ON roadmap.v_plm_delivered_evidence TO roadmap_ro;
GRANT SELECT ON roadmap.v_plm_incomplete TO roadmap_ro;
GRANT SELECT ON roadmap.v_plm_summary TO roadmap_ro;
