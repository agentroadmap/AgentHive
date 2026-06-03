-- Migration 122: P997 — legacy-to-agentHive2 proposal mapping artifact schema
--
-- Creates the control-plane table that records how each legacy proposal maps
-- into the agentHive2 documentation-shaped proposal stack, plus five query-
-- surface views consumed by classification agents and the inventory child (P998).
--
-- Classification vocabulary (P995):
--   retained          — kept as-is in agentHive2
--   delivered_evidence — completed with verified ACs; preserved as historical evidence
--   duplicate         — duplicate of another existing proposal
--   obsolete          — no longer relevant; no agentHive2 heir
--   reauthor_needed   — must be rewritten for the agentHive2 stack
--   superseded        — replaced by a canonical agentHive2 proposal
--
-- SOURCE-OF-TRUTH NOTE: proposal_migration_map is a projection/control-plane
-- helper. It does NOT replace the proposal lifecycle (status, maturity) in
-- roadmap_proposal.proposal. Agents must update both the mapping row AND the
-- proposal maturity independently. The lifecycle source of truth remains:
--   roadmap_proposal.proposal
--   roadmap_proposal.proposal_state_transitions
--   roadmap.gate_decision_log
--   roadmap_proposal.proposal_discussions
--
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE throughout).

BEGIN;

-- ── 1. Core mapping table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_migration_map (
    id                        BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Legacy proposal being classified, stored as display_id text ('P123').
    legacy_proposal_id        TEXT         NOT NULL,

    -- Optional FK to the actual proposal row for join-based queries.
    -- Set NULL if the legacy row is deleted or not present in this DB instance.
    legacy_proposal_row_id    BIGINT
                              REFERENCES roadmap_proposal.proposal(id)
                              ON DELETE SET NULL,

    -- The agentHive2 canonical node this legacy proposal maps to (display_id).
    -- NULL when classification is 'obsolete' or 'duplicate' with no heir.
    canonical_proposal_id     TEXT,

    -- Optional FK to the canonical proposal row.
    canonical_proposal_row_id BIGINT
                              REFERENCES roadmap_proposal.proposal(id)
                              ON DELETE SET NULL,

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
    -- Empty string is allowed on insert; flagged by v_migration_incomplete.
    rationale                 TEXT         NOT NULL DEFAULT '',

    -- Structured evidence pointers.
    -- Each element: {"type": "<kind>", "id"|"sha"|..., "notes": "<optional>"}
    -- Valid ref types: proposal | commit | ac | migration | discussion | doc
    evidence_refs             JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- When classification='superseded', the display_id of the replacing proposal.
    superseded_by_proposal_id TEXT,

    -- Optional FK to the superseding proposal row.
    superseded_by_row_id      BIGINT
                              REFERENCES roadmap_proposal.proposal(id)
                              ON DELETE SET NULL,

    -- Agent or human who reviewed and approved this classification.
    reviewed_by               TEXT,
    reviewed_at               TIMESTAMPTZ,

    -- Identity that inserted this row (MCP agent identity or operator).
    created_by                TEXT,

    -- Free-text annotation slot for operators or classification agents.
    notes                     TEXT,

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
    'P997: control-plane projection artifact mapping each legacy proposal to its '
    'agentHive2 canonical stack node. Classification vocabulary (P995): retained | '
    'delivered_evidence | duplicate | obsolete | reauthor_needed | superseded. '
    'This table does NOT replace the proposal lifecycle source of truth '
    '(roadmap_proposal.proposal, proposal_state_transitions, gate_decision_log, '
    'proposal_discussions). Agents must update mapping rows and proposal maturity '
    'independently.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.legacy_proposal_id IS
    'display_id of the legacy proposal being classified (e.g. ''P123''). UNIQUE.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.legacy_proposal_row_id IS
    'Optional FK to roadmap_proposal.proposal(id) for the legacy row. '
    'ON DELETE SET NULL — safe if the row is purged.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.canonical_proposal_id IS
    'display_id of the agentHive2 node this legacy proposal maps to. '
    'NULL for obsolete/duplicate proposals that have no agentHive2 heir.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.canonical_proposal_row_id IS
    'Optional FK to roadmap_proposal.proposal(id) for the canonical node.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.classification IS
    'P995 vocabulary. One of: retained | delivered_evidence | duplicate | '
    'obsolete | reauthor_needed | superseded.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.rationale IS
    'Justification for the classification. Empty string on initial insert; '
    'flagged as incomplete by v_migration_incomplete.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.evidence_refs IS
    'JSONB array of structured evidence pointers. '
    'Examples: {"type":"proposal","id":821}, {"type":"commit","sha":"6725408d"}, '
    '{"type":"ac","proposal_id":754,"item_number":3}, '
    '{"type":"migration","number":118}, {"type":"discussion","id":7012}.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.superseded_by_proposal_id IS
    'display_id of the proposal that supersedes this legacy one. '
    'Required when classification=''superseded'' (enforced by CHECK constraint).';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.reviewed_by IS
    'Identity of the agent or human who completed the review pass.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.created_by IS
    'MCP agent identity or operator that inserted this row.';

COMMENT ON COLUMN roadmap_proposal.proposal_migration_map.notes IS
    'Free-text annotation slot — for ad-hoc operator or agent notes.';

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

-- Fast lookup: all legacy proposals pointing to a given canonical node.
CREATE INDEX IF NOT EXISTS idx_pmm_canonical
    ON roadmap_proposal.proposal_migration_map (canonical_proposal_id)
    WHERE canonical_proposal_id IS NOT NULL;

-- Aggregations and filters by classification.
CREATE INDEX IF NOT EXISTS idx_pmm_classification
    ON roadmap_proposal.proposal_migration_map (classification);

-- Partial: classified but not yet linked to an agentHive2 heir.
-- (obsolete and duplicate intentionally omit a canonical heir.)
CREATE INDEX IF NOT EXISTS idx_pmm_needs_canonical
    ON roadmap_proposal.proposal_migration_map (legacy_proposal_id)
    WHERE canonical_proposal_id IS NULL
      AND classification NOT IN ('obsolete', 'duplicate');

-- Partial: rows that still need a review pass.
CREATE INDEX IF NOT EXISTS idx_pmm_unreviewed
    ON roadmap_proposal.proposal_migration_map (created_at)
    WHERE reviewed_by IS NULL;

-- ── 4. Query-surface views (AC-8) ─────────────────────────────────────────────

-- 4a. v_migration_unresolved
--     Rows missing reviewer OR timestamp OR canonical_id for non-obsolete,
--     OR missing superseded_by for duplicate/superseded classifications.
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_unresolved AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.superseded_by_proposal_id,
    m.reviewed_by,
    m.reviewed_at,
    m.updated_at
FROM roadmap_proposal.proposal_migration_map m
WHERE
    -- Missing reviewer or review timestamp
    m.reviewed_by IS NULL
    OR m.reviewed_at IS NULL
    -- Non-obsolete rows missing a canonical heir
    OR (m.canonical_proposal_id IS NULL
        AND m.classification NOT IN ('obsolete', 'duplicate'))
    -- Duplicate/superseded rows missing their replacement pointer
    OR (m.superseded_by_proposal_id IS NULL
        AND m.classification IN ('duplicate', 'superseded'));

COMMENT ON VIEW roadmap_proposal.v_migration_unresolved IS
    'P997: projection helper — control-plane artifact. Does NOT replace proposal '
    'lifecycle source of truth. Rows that are unresolved: missing reviewer, '
    'review timestamp, canonical_id for non-obsolete, or superseded_by for '
    'duplicate/superseded classifications.';

-- 4b. v_migration_dup_superseded
--     Duplicate and superseded rows with their replacement chain.
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_dup_superseded AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.classification,
    m.canonical_proposal_id,
    m.superseded_by_proposal_id,
    -- Resolve the superseding row's title where available
    sup.title                             AS superseded_by_title,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at,
    m.created_at
FROM roadmap_proposal.proposal_migration_map m
LEFT JOIN roadmap_proposal.proposal sup
       ON sup.display_id = m.superseded_by_proposal_id
WHERE m.classification IN ('duplicate', 'superseded');

COMMENT ON VIEW roadmap_proposal.v_migration_dup_superseded IS
    'P997: projection helper — control-plane artifact. Does NOT replace proposal '
    'lifecycle source of truth. Legacy proposals classified as duplicate or '
    'superseded, with the replacement chain resolved (superseded_by_title from '
    'roadmap_proposal.proposal where available).';

-- 4c. v_migration_delivered_evidence
--     Delivered-evidence rows with evidence count and missing-evidence flag.
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_delivered_evidence AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.rationale,
    m.evidence_refs,
    jsonb_array_length(m.evidence_refs)        AS evidence_ref_count,
    (jsonb_array_length(m.evidence_refs) = 0)  AS evidence_missing,
    m.reviewed_by,
    m.reviewed_at,
    m.created_at
FROM roadmap_proposal.proposal_migration_map m
WHERE m.classification = 'delivered_evidence';

COMMENT ON VIEW roadmap_proposal.v_migration_delivered_evidence IS
    'P997: projection helper — control-plane artifact. Does NOT replace proposal '
    'lifecycle source of truth. Legacy proposals classified as delivered_evidence '
    '(completed work with verified ACs). Includes evidence_ref_count and '
    'evidence_missing flag to surface rows that are missing evidence pointers.';

-- 4d. v_migration_incomplete
--     Rows missing any one of: reviewer, reviewed_at, evidence, canonical_id.
--     Per-column boolean flags for targeted triage.
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_incomplete AS
SELECT
    m.id,
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    m.classification,
    m.rationale,
    m.reviewed_by,
    m.reviewed_at,
    m.updated_at,
    -- Per-column boolean gap flags
    (m.reviewed_by IS NULL)                                            AS reviewer_missing,
    (m.reviewed_at IS NULL)                                            AS reviewed_at_missing,
    (jsonb_array_length(m.evidence_refs) = 0)                         AS evidence_missing,
    (m.canonical_proposal_id IS NULL
     AND m.classification NOT IN ('obsolete'))                         AS canonical_id_missing
FROM roadmap_proposal.proposal_migration_map m
WHERE
    m.reviewed_by IS NULL
    OR m.reviewed_at IS NULL
    OR jsonb_array_length(m.evidence_refs) = 0
    OR (m.canonical_proposal_id IS NULL AND m.classification NOT IN ('obsolete'));

COMMENT ON VIEW roadmap_proposal.v_migration_incomplete IS
    'P997: projection helper — control-plane artifact. Does NOT replace proposal '
    'lifecycle source of truth. Mapping rows with at least one incomplete field: '
    'reviewer, reviewed_at, evidence_refs, or canonical_id (for non-obsolete rows). '
    'Exposes per-column boolean flags for targeted triage.';

-- 4e. v_migration_classification_summary
--     Roll-up counts grouped by classification, with unreviewed count per bucket.
CREATE OR REPLACE VIEW roadmap_proposal.v_migration_classification_summary AS
SELECT
    classification,
    COUNT(*)                                          AS total,
    COUNT(*) FILTER (WHERE reviewed_by IS NOT NULL
                       AND reviewed_at IS NOT NULL)   AS reviewed_count,
    COUNT(*) FILTER (WHERE reviewed_by IS NULL
                        OR reviewed_at IS NULL)        AS unreviewed_count,
    COUNT(*) FILTER (WHERE canonical_proposal_id IS NOT NULL) AS with_canonical,
    COUNT(*) FILTER (WHERE canonical_proposal_id IS NULL)     AS without_canonical
FROM roadmap_proposal.proposal_migration_map
GROUP BY classification
ORDER BY classification;

COMMENT ON VIEW roadmap_proposal.v_migration_classification_summary IS
    'P997: projection helper — control-plane artifact. Does NOT replace proposal '
    'lifecycle source of truth. Roll-up counts by P995 classification vocabulary, '
    'with reviewed/unreviewed and canonical/no-canonical breakdowns per bucket.';

-- ── 5. Role grants (no-op when roles do not exist) ───────────────────────────

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_agent_reader') THEN
        GRANT SELECT ON roadmap_proposal.proposal_migration_map              TO roadmap_agent_reader;
        GRANT SELECT ON roadmap_proposal.v_migration_unresolved              TO roadmap_agent_reader;
        GRANT SELECT ON roadmap_proposal.v_migration_dup_superseded          TO roadmap_agent_reader;
        GRANT SELECT ON roadmap_proposal.v_migration_delivered_evidence      TO roadmap_agent_reader;
        GRANT SELECT ON roadmap_proposal.v_migration_incomplete              TO roadmap_agent_reader;
        GRANT SELECT ON roadmap_proposal.v_migration_classification_summary  TO roadmap_agent_reader;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roadmap_agent_writer') THEN
        GRANT SELECT, INSERT, UPDATE
            ON roadmap_proposal.proposal_migration_map                       TO roadmap_agent_writer;
        GRANT USAGE, SELECT
            ON SEQUENCE roadmap_proposal.proposal_migration_map_id_seq       TO roadmap_agent_writer;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON roadmap_proposal.proposal_migration_map                       TO admin;
        GRANT USAGE, SELECT
            ON SEQUENCE roadmap_proposal.proposal_migration_map_id_seq       TO admin;
        GRANT SELECT ON roadmap_proposal.v_migration_unresolved              TO admin;
        GRANT SELECT ON roadmap_proposal.v_migration_dup_superseded          TO admin;
        GRANT SELECT ON roadmap_proposal.v_migration_delivered_evidence      TO admin;
        GRANT SELECT ON roadmap_proposal.v_migration_incomplete              TO admin;
        GRANT SELECT ON roadmap_proposal.v_migration_classification_summary  TO admin;
    END IF;
END $$;

-- ── 6. Self-register in roadmap.migration_history ────────────────────────────

INSERT INTO roadmap.migration_history (
    filename,
    checksum_sha256,
    applied_at,
    applied_by,
    environment,
    status
)
VALUES (
    '122-p997-proposal-migration-map.sql',
    'pending',
    now(),
    'migration-runner',
    'production',
    'applied'
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;
