-- Migration 135: P997 — legacy-to-agentHive2 proposal mapping artifact
--
-- Creates the control-plane table that records how each legacy proposal
-- maps into the agentHive2 documentation-shaped proposal stack, plus
-- four query-surface views consumed by classification agents and the
-- inventory child (P998).
--
-- Classification vocabulary (P995):
--   retained          — proposal kept as-is in agentHive2
--   delivered_evidence — completed with verified ACs; kept as historical evidence
--   duplicate         — duplicate of another existing proposal
--   obsolete          — no longer relevant; no agentHive2 heir
--   reauthor_needed   — must be rewritten for the agentHive2 stack
--   superseded        — replaced by a canonical agentHive2 proposal
--
-- IMPORTANT: This is a projection / control-plane helper.
-- The lifecycle source of truth remains roadmap_proposal.proposal.
-- No proposal status or maturity must ever be set from this table alone.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE throughout).

BEGIN;

-- ── 1. Core mapping table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_migration_map (
    id                        BIGSERIAL    PRIMARY KEY,

    -- Legacy proposal being classified, in display_id form ('P123').
    legacy_proposal_id        TEXT         NOT NULL,

    -- The agentHive2 canonical node this legacy proposal maps to.
    -- NULL when the legacy proposal is obsolete or duplicate with no heir.
    canonical_proposal_id     TEXT,

    -- P995 classification vocabulary (see file header for definitions).
    classification            TEXT         NOT NULL
        CHECK (classification IN (
            'retained',
            'delivered_evidence',
            'duplicate',
            'obsolete',
            'reauthor_needed',
            'superseded'
        )),

    -- Human-readable rationale justifying the classification decision.
    rationale                 TEXT,

    -- Structured evidence: commits, AC IDs, review IDs, discussion IDs,
    -- doc paths, migration IDs, etc.
    -- Each element: {"type": "<kind>", "ref": "<value>", "notes": "<optional>"}
    -- Valid types: commit | ac_id | review_id | discussion_id | doc_path | migration_id
    evidence_refs             JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- When classification='superseded', names the replacing proposal (display_id).
    superseded_by_proposal_id TEXT,

    -- Agent or human who reviewed and approved this classification.
    reviewed_by               TEXT,
    reviewed_at               TIMESTAMPTZ,

    created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Each legacy proposal is mapped at most once.
    CONSTRAINT pmm_legacy_unique UNIQUE (legacy_proposal_id),

    -- Superseded rows must name their replacement.
    CONSTRAINT pmm_superseded_needs_replacement CHECK (
        classification <> 'superseded' OR superseded_by_proposal_id IS NOT NULL
    )
);

COMMENT ON TABLE roadmap_proposal.proposal_migration_map IS
    'P997: control-plane artifact mapping each legacy proposal to its agentHive2 canonical '
    'node. Classification vocabulary: retained | delivered_evidence | duplicate | obsolete | '
    'reauthor_needed | superseded. This is a projection helper — proposal lifecycle source '
    'of truth remains roadmap_proposal.proposal.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.legacy_proposal_id IS
    'display_id of the legacy proposal being classified (e.g. ''P123'').';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.canonical_proposal_id IS
    'display_id of the agentHive2 node this legacy proposal maps to. '
    'NULL for obsolete/duplicate proposals that have no agentHive2 heir.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.evidence_refs IS
    'JSONB array of evidence pointers: [{type, ref, notes}]. '
    'Valid types: commit | ac_id | review_id | discussion_id | doc_path | migration_id.';

-- ── 2. updated_at trigger ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_pmm_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_pmm_updated_at ON roadmap_proposal.proposal_migration_map;
CREATE TRIGGER tg_pmm_updated_at
    BEFORE UPDATE ON roadmap_proposal.proposal_migration_map
    FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_pmm_set_updated_at();

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

-- Fast lookup of all legacy proposals that point to a given canonical node.
CREATE INDEX IF NOT EXISTS idx_pmm_canonical
    ON roadmap_proposal.proposal_migration_map (canonical_proposal_id)
    WHERE canonical_proposal_id IS NOT NULL;

-- Aggregations and filters by classification.
CREATE INDEX IF NOT EXISTS idx_pmm_classification
    ON roadmap_proposal.proposal_migration_map (classification);

-- Partial index: classified but not yet linked to an agentHive2 heir
-- (obsolete and duplicate intentionally omit a canonical heir).
CREATE INDEX IF NOT EXISTS idx_pmm_unresolved
    ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
    WHERE canonical_proposal_id IS NULL
      AND classification NOT IN ('obsolete', 'duplicate');

-- Partial index: rows that still need a human/agent review pass.
CREATE INDEX IF NOT EXISTS idx_pmm_needs_review
    ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
    WHERE reviewed_by IS NULL OR rationale IS NULL;

-- ── 4. Query-surface views ────────────────────────────────────────────────────

-- 4a. Unresolved: classified but not yet linked to a canonical agentHive2 node.
--     Excludes obsolete and duplicate, which legitimately have no heir.
CREATE OR REPLACE VIEW roadmap.v_migration_unresolved AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at,
    m.updated_at
FROM roadmap_proposal.proposal_migration_map m
WHERE m.canonical_proposal_id IS NULL
  AND m.classification NOT IN ('obsolete', 'duplicate');

COMMENT ON VIEW roadmap.v_migration_unresolved IS
    'P997: legacy proposals that are classified but not yet linked to a canonical '
    'agentHive2 node. Obsolete and duplicate rows are excluded because they '
    'intentionally carry no heir.';

-- 4b. Duplicate and superseded: legacy rows that are replaced by something else.
CREATE OR REPLACE VIEW roadmap.v_migration_duplicate_superseded AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.superseded_by_proposal_id,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at
FROM roadmap_proposal.proposal_migration_map m
WHERE m.classification IN ('duplicate', 'superseded');

COMMENT ON VIEW roadmap.v_migration_duplicate_superseded IS
    'P997: legacy proposals classified as duplicate or superseded. '
    'superseded rows always carry a superseded_by_proposal_id (enforced by constraint).';

-- 4c. Delivered evidence: completed work preserved as historical record.
CREATE OR REPLACE VIEW roadmap.v_migration_delivered_evidence AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.evidence_refs,
    m.reviewed_by,
    m.reviewed_at
FROM roadmap_proposal.proposal_migration_map m
WHERE m.classification = 'delivered_evidence';

COMMENT ON VIEW roadmap.v_migration_delivered_evidence IS
    'P997: legacy proposals classified as delivered_evidence — completed work with verified '
    'ACs that is preserved as historical record under a canonical agentHive2 node.';

-- 4d. Needs review: rows missing reviewer, rationale, or both.
CREATE OR REPLACE VIEW roadmap.v_migration_needs_review AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at,
    m.updated_at,
    CASE
        WHEN m.reviewed_by IS NULL AND m.rationale IS NULL THEN 'missing reviewer and rationale'
        WHEN m.reviewed_by IS NULL                         THEN 'missing reviewer'
        ELSE                                                    'missing rationale'
    END AS gap
FROM roadmap_proposal.proposal_migration_map m
WHERE m.reviewed_by IS NULL OR m.rationale IS NULL;

COMMENT ON VIEW roadmap.v_migration_needs_review IS
    'P997: mapping rows that are incomplete — missing a reviewer, a rationale, or both. '
    'These require human or agent attention before the mapping is audit-complete.';

-- ── 5. Role grants (no-op when roles do not exist) ───────────────────────────

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_agent_reader') THEN
        GRANT SELECT ON roadmap_proposal.proposal_migration_map    TO roadmap_agent_reader;
        GRANT SELECT ON roadmap.v_migration_unresolved             TO roadmap_agent_reader;
        GRANT SELECT ON roadmap.v_migration_duplicate_superseded   TO roadmap_agent_reader;
        GRANT SELECT ON roadmap.v_migration_delivered_evidence     TO roadmap_agent_reader;
        GRANT SELECT ON roadmap.v_migration_needs_review           TO roadmap_agent_reader;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_agent_writer') THEN
        GRANT SELECT, INSERT, UPDATE
            ON roadmap_proposal.proposal_migration_map             TO roadmap_agent_writer;
        GRANT USAGE, SELECT
            ON SEQUENCE roadmap_proposal.proposal_migration_map_id_seq TO roadmap_agent_writer;
    END IF;
END $$;

COMMIT;
