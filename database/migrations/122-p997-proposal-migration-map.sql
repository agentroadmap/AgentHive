-- Migration 122: P997 — legacy-to-agentHive2 proposal mapping artifact
--
-- Creates the control-plane audit table and query views that record how each
-- legacy proposal row maps into the agentHive2 documentation-shaped proposal
-- stack. This table is the authoritative mapping used by P998 (corpus
-- inventory) and P999 (documentation projection demo).
--
-- SOURCE OF TRUTH NOTE: proposal_migration_map is a projection helper and
-- migration audit log. It does NOT replace the proposal lifecycle in
-- roadmap_proposal.proposal (status/maturity), gate_decision_log, or
-- proposal_discussions. Agents must update both the mapping row here AND the
-- proposal maturity independently.
--
-- Supersedes: database/migrations/121-p997-proposal-migration-map.sql (draft,
-- wrong number, missing FK columns, wrong view names, no BEGIN/COMMIT).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: roadmap.proposal_migration_map
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.proposal_migration_map (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Text identifier for the legacy proposal (display_id or numeric string).
    -- Stored as BIGINT so it can be used directly in SQL JOINs against
    -- roadmap_proposal.proposal.id during the inventory phase.
    legacy_proposal_id          BIGINT NOT NULL,

    -- Optional FK to the actual proposals row; NULL if the row has been
    -- hard-deleted or not yet resolved. ON DELETE SET NULL ensures the
    -- mapping row survives proposal deletion.
    legacy_proposal_row_id      BIGINT
                                    REFERENCES roadmap_proposal.proposal(id)
                                    ON DELETE SET NULL,

    -- The agentHive2 canonical proposal that owns or supersedes this legacy
    -- row. NULL for pure obsolete rows or delivered-evidence rows not grouped
    -- under a canonical node.
    canonical_proposal_id       BIGINT,

    canonical_proposal_row_id   BIGINT
                                    REFERENCES roadmap_proposal.proposal(id)
                                    ON DELETE SET NULL,

    -- Classification vocabulary (P995 §Design §Mapping Artifact):
    --   retained          — active, still developed, no re-authoring needed
    --   delivered_evidence — COMPLETE with verified ACs; referenced as evidence
    --   duplicate         — near-duplicate of another proposal
    --   obsolete          — stale, superseded, or irrelevant
    --   reauthor_needed   — incomplete or misleading; needs a fresh canonical record
    --   superseded        — explicitly replaced by canonical_proposal_id
    classification              TEXT NOT NULL
                                    CHECK (classification IN (
                                        'retained',
                                        'delivered_evidence',
                                        'duplicate',
                                        'obsolete',
                                        'reauthor_needed',
                                        'superseded'
                                    )),

    -- Agent- or human-readable reason for the classification. Must be
    -- non-empty; a one-sentence summary is sufficient.
    rationale                   TEXT NOT NULL CHECK (rationale <> ''),

    -- Structured evidence: array of {type, ...} objects. Supported types:
    -- proposal, commit, ac, migration, discussion.
    -- Example: [{"type":"commit","sha":"6725408d"},{"type":"migration","number":118}]
    evidence_refs               JSONB NOT NULL DEFAULT '[]',

    -- When classification is 'superseded' or 'duplicate', points to the
    -- replacing proposal (by legacy display_id integer).
    superseded_by_proposal_id   BIGINT,

    superseded_by_row_id        BIGINT
                                    REFERENCES roadmap_proposal.proposal(id)
                                    ON DELETE SET NULL,

    -- Reviewer identity (agent alias or human email/name).
    reviewed_by                 TEXT,
    reviewed_at                 TIMESTAMPTZ,

    -- Who created this mapping row (agent alias).
    created_by                  TEXT,

    -- Free-form notes (e.g. "needs second opinion", "defer until P999").
    notes                       TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_pmm_legacy_proposal_id UNIQUE (legacy_proposal_id)
);

COMMENT ON TABLE roadmap.proposal_migration_map IS
    'Control-plane projection helper: records how each legacy proposal row maps '
    'into the agentHive2 documentation-shaped proposal stack. '
    'This is a MIGRATION AUDIT LOG only — it does NOT replace the lifecycle '
    'source of truth in roadmap_proposal.proposal, gate_decision_log, or '
    'proposal_discussions. Populated by P998; queried by P999.';

COMMENT ON COLUMN roadmap.proposal_migration_map.legacy_proposal_id IS
    'Numeric proposal ID of the legacy row being classified. '
    'Matches roadmap_proposal.proposal.id.';

COMMENT ON COLUMN roadmap.proposal_migration_map.legacy_proposal_row_id IS
    'FK to roadmap_proposal.proposal(id) for the legacy row. '
    'NULL if the row was hard-deleted or not yet resolved. '
    'SET NULL on delete so the mapping survives proposal pruning.';

COMMENT ON COLUMN roadmap.proposal_migration_map.canonical_proposal_id IS
    'Numeric ID of the agentHive2 canonical proposal that owns or supersedes '
    'this legacy row. NULL for unparented obsolete rows.';

COMMENT ON COLUMN roadmap.proposal_migration_map.classification IS
    'P995 vocabulary: retained | delivered_evidence | duplicate | '
    'obsolete | reauthor_needed | superseded. '
    'Enforced by CHECK constraint — no other values accepted.';

COMMENT ON COLUMN roadmap.proposal_migration_map.rationale IS
    'Non-empty human/agent-readable reason for the classification. '
    'One sentence minimum. Required before a row is considered reviewed.';

COMMENT ON COLUMN roadmap.proposal_migration_map.evidence_refs IS
    'JSONB array of structured evidence references. '
    'Supported object shapes: '
    '{type:"proposal",id:N}, {type:"commit",sha:"..."}, '
    '{type:"ac",proposal_id:N,item_number:N}, '
    '{type:"migration",number:N}, {type:"discussion",id:N}.';

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pmm_canonical_proposal_id
    ON roadmap.proposal_migration_map (canonical_proposal_id)
    WHERE canonical_proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pmm_classification
    ON roadmap.proposal_migration_map (classification);

-- Partial index for the review queue — only unreviewed rows need scanning.
CREATE INDEX IF NOT EXISTS idx_pmm_unreviewed
    ON roadmap.proposal_migration_map (created_at)
    WHERE reviewed_by IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER: keep updated_at current on every UPDATE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_pmm_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pmm_updated_at ON roadmap.proposal_migration_map;
CREATE TRIGGER trg_pmm_updated_at
    BEFORE UPDATE ON roadmap.proposal_migration_map
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_pmm_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ADD FK COLUMNS to existing table if 121-p997 draft was already applied
-- (idempotent; IF NOT EXISTS prevents errors on fresh installs)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name   = 'proposal_migration_map'
          AND column_name  = 'legacy_proposal_row_id'
    ) THEN
        ALTER TABLE roadmap.proposal_migration_map
            ADD COLUMN legacy_proposal_row_id BIGINT
                REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name   = 'proposal_migration_map'
          AND column_name  = 'canonical_proposal_row_id'
    ) THEN
        ALTER TABLE roadmap.proposal_migration_map
            ADD COLUMN canonical_proposal_row_id BIGINT
                REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name   = 'proposal_migration_map'
          AND column_name  = 'superseded_by_row_id'
    ) THEN
        ALTER TABLE roadmap.proposal_migration_map
            ADD COLUMN superseded_by_row_id BIGINT
                REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name   = 'proposal_migration_map'
          AND column_name  = 'created_by'
    ) THEN
        ALTER TABLE roadmap.proposal_migration_map
            ADD COLUMN created_by TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name   = 'proposal_migration_map'
          AND column_name  = 'notes'
    ) THEN
        ALTER TABLE roadmap.proposal_migration_map
            ADD COLUMN notes TEXT;
    END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 1: v_migration_unresolved
-- Rows that are not yet fully reviewed or are missing required linkage.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_migration_unresolved AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at,
    m.created_at
FROM roadmap.proposal_migration_map m
WHERE
    -- Missing reviewer or review timestamp
    m.reviewed_by IS NULL
    OR m.reviewed_at IS NULL
    -- Non-obsolete rows with no canonical target
    OR (m.classification NOT IN ('obsolete') AND m.canonical_proposal_id IS NULL)
    -- Duplicate/superseded rows with no superseded_by pointer
    OR (m.classification IN ('duplicate', 'superseded') AND m.superseded_by_proposal_id IS NULL)
ORDER BY m.legacy_proposal_id;

COMMENT ON VIEW roadmap.v_migration_unresolved IS
    'Mapping rows that require follow-up: missing reviewer, missing review '
    'timestamp, non-obsolete rows without a canonical target, or '
    'duplicate/superseded rows without a superseded_by pointer. '
    'Part of P997 AC-3 and AC-8 query surface. '
    'This view is a PROJECTION HELPER only — it does not replace the '
    'lifecycle source of truth in roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 2: v_migration_dup_superseded
-- Duplicate and superseded rows with their replacement chain.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_migration_dup_superseded AS
SELECT
    m.legacy_proposal_id,
    m.classification,
    m.rationale,
    m.superseded_by_proposal_id     AS replaced_by_proposal_id,
    m.canonical_proposal_id,
    m.reviewed_by,
    m.reviewed_at,
    -- Show the replacement chain title when available
    rep.id                          AS replacement_row_id
FROM roadmap.proposal_migration_map m
LEFT JOIN roadmap.proposal_migration_map rep
    ON rep.legacy_proposal_id = m.superseded_by_proposal_id
WHERE m.classification IN ('duplicate', 'superseded')
ORDER BY m.classification, m.legacy_proposal_id;

COMMENT ON VIEW roadmap.v_migration_dup_superseded IS
    'Duplicate and superseded mapping rows with their replacement chain. '
    'Joins to proposal_migration_map on superseded_by_proposal_id to show '
    'whether the replacement itself is mapped. '
    'Part of P997 AC-3 and AC-8 query surface. '
    'This view is a PROJECTION HELPER only — it does not replace the '
    'lifecycle source of truth in roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 3: v_migration_delivered_evidence
-- Delivered-evidence rows with evidence count and missing-evidence flag.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_migration_delivered_evidence AS
SELECT
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.rationale,
    m.evidence_refs,
    jsonb_array_length(m.evidence_refs)             AS evidence_ref_count,
    (jsonb_array_length(m.evidence_refs) = 0)       AS evidence_missing,
    m.reviewed_by,
    m.reviewed_at
FROM roadmap.proposal_migration_map m
WHERE m.classification = 'delivered_evidence'
ORDER BY m.canonical_proposal_id NULLS LAST, m.legacy_proposal_id;

COMMENT ON VIEW roadmap.v_migration_delivered_evidence IS
    'Mapping rows classified as delivered_evidence (COMPLETE proposals with '
    'verified ACs, referenced as evidence not re-authored). '
    'Exposes evidence_ref_count and evidence_missing flag for quality checks. '
    'Part of P997 AC-3 and AC-8 query surface. '
    'This view is a PROJECTION HELPER only — it does not replace the '
    'lifecycle source of truth in roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 4: v_migration_incomplete
-- All rows with per-column boolean flags for every missing field.
-- Superset of v_migration_unresolved; designed for bulk triage.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_migration_incomplete AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.classification,
    m.reviewed_by,
    m.reviewed_at,
    m.canonical_proposal_id,
    m.superseded_by_proposal_id,
    m.evidence_refs,

    -- Per-column boolean flags
    (m.reviewed_by  IS NULL)                                                AS missing_reviewer,
    (m.reviewed_at  IS NULL)                                                AS missing_reviewed_at,
    (jsonb_array_length(m.evidence_refs) = 0)                               AS missing_evidence,
    (m.canonical_proposal_id IS NULL
        AND m.classification NOT IN ('obsolete'))                           AS missing_canonical_id,
    (m.superseded_by_proposal_id IS NULL
        AND m.classification IN ('duplicate', 'superseded'))                AS missing_superseded_by
FROM roadmap.proposal_migration_map m
WHERE
    m.reviewed_by IS NULL
    OR m.reviewed_at IS NULL
    OR jsonb_array_length(m.evidence_refs) = 0
    OR (m.canonical_proposal_id IS NULL AND m.classification NOT IN ('obsolete'))
    OR (m.superseded_by_proposal_id IS NULL AND m.classification IN ('duplicate', 'superseded'))
ORDER BY m.legacy_proposal_id;

COMMENT ON VIEW roadmap.v_migration_incomplete IS
    'All mapping rows with at least one incomplete field, with per-column '
    'boolean flags: missing_reviewer, missing_reviewed_at, missing_evidence, '
    'missing_canonical_id, missing_superseded_by. '
    'Designed for bulk triage during the P998 corpus inventory phase. '
    'Part of P997 AC-3 and AC-8 query surface. '
    'This view is a PROJECTION HELPER only — it does not replace the '
    'lifecycle source of truth in roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 5: v_migration_classification_summary
-- Roll-up counts by classification, with reviewed vs unreviewed breakdown.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_migration_classification_summary AS
SELECT
    m.classification,
    COUNT(*)                                                    AS total,
    COUNT(*) FILTER (WHERE m.reviewed_by IS NOT NULL
                       AND m.reviewed_at IS NOT NULL)           AS reviewed,
    COUNT(*) FILTER (WHERE m.reviewed_by IS NULL
                       OR  m.reviewed_at IS NULL)               AS unreviewed,
    COUNT(*) FILTER (WHERE jsonb_array_length(m.evidence_refs) > 0) AS with_evidence,
    COUNT(*) FILTER (WHERE jsonb_array_length(m.evidence_refs) = 0) AS without_evidence
FROM roadmap.proposal_migration_map m
GROUP BY m.classification
ORDER BY total DESC;

COMMENT ON VIEW roadmap.v_migration_classification_summary IS
    'Roll-up counts grouped by classification. Shows total, reviewed, '
    'unreviewed, with_evidence, and without_evidence per category. '
    'Used as a progress dashboard during the P998 corpus inventory phase. '
    'Part of P997 AC-3 and AC-8 query surface. '
    'This view is a PROJECTION HELPER only — it does not replace the '
    'lifecycle source of truth in roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- DROP obsolete view names from the 121-p997 draft (if applied)
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS roadmap.v_migration_superseded;
DROP VIEW IF EXISTS roadmap.v_migration_projection_tree;

COMMIT;
