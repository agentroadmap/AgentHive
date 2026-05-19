-- Migration 128: P995 — documentation projection views
--
-- Defines the documentation-shaped projection layer over the agentHive2
-- proposal stack. All views are read-only projections of
-- roadmap_proposal.proposal and roadmap_proposal.proposal_migration_map;
-- they are NOT lifecycle source-of-truth tables.
--
-- Views created:
--   v_doc_tree               — recursive hierarchy from P1013 Grand Picture
--   v_doc_grand_picture      — top-level overview node
--   v_doc_pillar_architecture — direct pillar children of P1013
--   v_doc_implementation_roadmap — active non-complete proposals per pillar
--   v_doc_completed_inventory — delivered_evidence corpus
--   v_doc_open_work_queue    — retained/reauthor proposals still in flight
--   v_doc_migration_plan     — full migration classification overview
--   v_doc_glossary           — status/type vocabulary reference
--   v_doc_verification_matrix — AC completion counts per pillar
--
-- AC-6 of P995: documentation projection views for all 8 documentation
-- categories defined in the P995 design.

BEGIN;

-- Drop all views before recreating (column renames require drop+recreate)
DROP VIEW IF EXISTS roadmap_proposal.v_doc_verification_matrix CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_glossary CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_migration_plan CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_open_work_queue CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_completed_inventory CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_implementation_roadmap CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_pillar_architecture CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_grand_picture CASCADE;
DROP VIEW IF EXISTS roadmap_proposal.v_doc_tree CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 1: v_doc_tree
-- Recursive hierarchy rooted at P1013 (Grand Picture, id=1013).
-- Joins migration_map classification for each canonical node.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_tree AS
WITH RECURSIVE tree AS (
    SELECT
        p.id,
        p.display_id,
        p.parent_id,
        p.type,
        p.status,
        p.maturity,
        p.title,
        p.summary,
        0                               AS depth,
        ARRAY[p.id]                     AS path,
        p.display_id::text              AS display_path
    FROM roadmap_proposal.proposal p
    WHERE p.id = 1013   -- P1013 Grand Picture anchor

    UNION ALL

    SELECT
        p.id,
        p.display_id,
        p.parent_id,
        p.type,
        p.status,
        p.maturity,
        p.title,
        p.summary,
        t.depth + 1,
        t.path || p.id,
        t.display_path || ' > ' || p.display_id
    FROM roadmap_proposal.proposal p
    JOIN tree t ON p.parent_id = t.id
    WHERE NOT (p.id = ANY(t.path))  -- cycle guard
)
SELECT
    t.id,
    t.display_id,
    t.parent_id,
    t.type,
    t.status,
    t.maturity,
    t.title,
    t.summary,
    t.depth,
    t.display_path,
    msum.legacy_count,
    msum.delivered_count,
    msum.retained_count,
    msum.obsolete_count
FROM tree t
LEFT JOIN (
    SELECT
        NULLIF(regexp_replace(canonical_proposal_id, '^P', '', 'i'), '')::bigint AS cid,
        COUNT(*)                                                        AS legacy_count,
        COUNT(*) FILTER (WHERE classification = 'delivered_evidence')  AS delivered_count,
        COUNT(*) FILTER (WHERE classification = 'retained')            AS retained_count,
        COUNT(*) FILTER (WHERE classification = 'obsolete')            AS obsolete_count
    FROM roadmap_proposal.proposal_migration_map
    WHERE canonical_proposal_id IS NOT NULL
    GROUP BY 1
) msum ON msum.cid = t.id
ORDER BY t.path;

COMMENT ON VIEW roadmap_proposal.v_doc_tree IS
    'Recursive documentation tree rooted at P1013 (Grand Picture). '
    'Walks parent_id hierarchy; joins aggregated migration_map counts per '
    'canonical node (legacy_count, delivered_count, retained_count, obsolete_count). '
    'P995 AC-6 — Grand Picture documentation layer. '
    'PROJECTION ONLY — lifecycle source of truth is roadmap_proposal.proposal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 2: v_doc_grand_picture
-- Single-row overview of the Grand Picture node with pillar count.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_grand_picture AS
SELECT
    p.id,
    p.display_id,
    p.title,
    p.status,
    p.maturity,
    p.summary,
    COUNT(c.id)                 AS pillar_count,
    COUNT(c.id) FILTER (WHERE c.status = 'COMPLETE')  AS pillars_complete,
    COUNT(c.id) FILTER (WHERE c.status = 'DEVELOP')   AS pillars_in_develop,
    COUNT(c.id) FILTER (WHERE c.status = 'DRAFT')     AS pillars_in_draft
FROM roadmap_proposal.proposal p
LEFT JOIN roadmap_proposal.proposal c ON c.parent_id = p.id
WHERE p.id = 1013
GROUP BY p.id, p.display_id, p.title, p.status, p.maturity, p.summary;

COMMENT ON VIEW roadmap_proposal.v_doc_grand_picture IS
    'Single-row Grand Picture overview with pillar counts by status. '
    'P995 AC-6 — Grand Picture documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 3: v_doc_pillar_architecture
-- One row per pillar — direct children of P1013 — with child counts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_pillar_architecture AS
SELECT
    p.id,
    p.display_id,
    p.title,
    p.status,
    p.maturity,
    p.summary,
    COUNT(c.id)                                        AS child_count,
    COUNT(c.id) FILTER (WHERE c.status = 'COMPLETE')  AS children_complete,
    COUNT(c.id) FILTER (WHERE c.type  = 'architecture') AS children_arch,
    COUNT(c.id) FILTER (WHERE c.type != 'architecture'
                          OR  c.type IS NULL)          AS children_impl
FROM roadmap_proposal.proposal p
LEFT JOIN roadmap_proposal.proposal c ON c.parent_id = p.id
WHERE p.parent_id = 1013
GROUP BY p.id, p.display_id, p.title, p.status, p.maturity, p.summary
ORDER BY p.id;

COMMENT ON VIEW roadmap_proposal.v_doc_pillar_architecture IS
    'One row per agentHive2 pillar (direct children of P1013). '
    'Includes child counts by status and type. '
    'P995 AC-6 — Pillar Architecture documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 4: v_doc_implementation_roadmap
-- Active (non-COMPLETE, non-DRAFT-idle) proposals descended from a pillar.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_implementation_roadmap AS
WITH RECURSIVE pillar_ids AS (
    SELECT id AS pillar_id, display_id AS pillar_display_id, title AS pillar_title
    FROM roadmap_proposal.proposal
    WHERE parent_id = 1013
),
descendants AS (
    SELECT p.id, p.display_id, p.type, p.status, p.maturity,
           p.title, p.summary, p.priority, p.parent_id,
           pi.pillar_id, pi.pillar_display_id, pi.pillar_title
    FROM roadmap_proposal.proposal p
    JOIN pillar_ids pi ON p.parent_id = pi.pillar_id
    WHERE p.status NOT IN ('COMPLETE', 'OBSOLETE')

    UNION ALL

    SELECT p.id, p.display_id, p.type, p.status, p.maturity,
           p.title, p.summary, p.priority, p.parent_id,
           d.pillar_id, d.pillar_display_id, d.pillar_title
    FROM roadmap_proposal.proposal p
    JOIN descendants d ON p.parent_id = d.id
    WHERE p.status NOT IN ('COMPLETE', 'OBSOLETE')
)
SELECT DISTINCT
    pillar_display_id,
    pillar_title,
    id,
    display_id,
    type,
    status,
    maturity,
    title,
    summary,
    priority
FROM descendants
ORDER BY pillar_display_id, status, id;

COMMENT ON VIEW roadmap_proposal.v_doc_implementation_roadmap IS
    'Active (non-complete, non-obsolete) proposals under each pillar. '
    'Recursive walk from pillars downward. '
    'P995 AC-6 — Implementation Roadmap documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 5: v_doc_completed_inventory
-- Proposals classified as delivered_evidence — the completed work corpus.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_completed_inventory AS
SELECT
    m.legacy_proposal_id,
    m.canonical_proposal_id,
    p_leg.display_id        AS legacy_display_id,
    p_leg.title             AS legacy_title,
    p_leg.status            AS legacy_status,
    p_can.display_id        AS canonical_display_id,
    p_can.title             AS canonical_pillar_title,
    m.rationale,
    m.evidence_refs,
    jsonb_array_length(m.evidence_refs) AS evidence_ref_count,
    m.reviewed_by,
    m.reviewed_at
FROM roadmap_proposal.proposal_migration_map m
LEFT JOIN roadmap_proposal.proposal p_leg ON p_leg.id = m.legacy_proposal_row_id
LEFT JOIN roadmap_proposal.proposal p_can ON p_can.id = NULLIF(regexp_replace(m.canonical_proposal_id, '^P', '', 'i'), '')::bigint
WHERE m.classification = 'delivered_evidence'
ORDER BY m.canonical_proposal_id NULLS LAST, m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_doc_completed_inventory IS
    'Completed work corpus: all proposals classified as delivered_evidence, '
    'showing legacy↔canonical linkage and evidence refs. '
    'P995 AC-6 — Completed Work Inventory documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 6: v_doc_open_work_queue
-- Retained and reauthor_needed proposals still in flight.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_open_work_queue AS
SELECT
    m.legacy_proposal_id,
    m.classification,
    p_leg.display_id    AS display_id,
    p_leg.title         AS title,
    p_leg.status        AS status,
    p_leg.maturity      AS maturity,
    p_leg.priority      AS priority,
    m.canonical_proposal_id,
    p_can.display_id    AS canonical_pillar_display_id,
    m.rationale,
    m.notes
FROM roadmap_proposal.proposal_migration_map m
LEFT JOIN roadmap_proposal.proposal p_leg ON p_leg.id = m.legacy_proposal_row_id
LEFT JOIN roadmap_proposal.proposal p_can ON p_can.id = NULLIF(regexp_replace(m.canonical_proposal_id, '^P', '', 'i'), '')::bigint
WHERE m.classification IN ('retained', 'reauthor_needed')
ORDER BY m.classification, m.canonical_proposal_id NULLS LAST, m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_doc_open_work_queue IS
    'Open work queue: retained and reauthor_needed proposals still in flight. '
    'Shows status, maturity, priority, and owning pillar. '
    'P995 AC-6 — Open Work Queue documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 7: v_doc_migration_plan
-- Full migration map snapshot — one row per legacy proposal with
-- classification, canonical target, and supersession chain.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_migration_plan AS
SELECT
    m.legacy_proposal_id,
    p_leg.display_id            AS legacy_display_id,
    p_leg.title                 AS legacy_title,
    p_leg.status                AS legacy_status,
    m.classification,
    m.rationale,
    m.canonical_proposal_id,
    p_can.display_id            AS canonical_pillar_display_id,
    p_can.title                 AS canonical_pillar_title,
    m.superseded_by_proposal_id,
    p_sup.display_id            AS superseded_by_display_id,
    m.reviewed_by,
    m.reviewed_at,
    m.notes
FROM roadmap_proposal.proposal_migration_map m
LEFT JOIN roadmap_proposal.proposal p_leg ON p_leg.id = m.legacy_proposal_row_id
LEFT JOIN roadmap_proposal.proposal p_can ON p_can.id = NULLIF(regexp_replace(m.canonical_proposal_id, '^P', '', 'i'), '')::bigint::bigint
LEFT JOIN roadmap_proposal.proposal p_sup ON p_sup.id = m.superseded_by_row_id
ORDER BY m.classification, m.canonical_proposal_id NULLS LAST, m.legacy_proposal_id;

COMMENT ON VIEW roadmap_proposal.v_doc_migration_plan IS
    'Full migration/cutover plan: all 144 mapping rows with classification, '
    'canonical target, and supersession chain. '
    'P995 AC-6 — Migration/Cutover Plan documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 8: v_doc_glossary
-- Vocabulary reference: proposal types, status terms, maturity terms,
-- and migration classification vocabulary from the CHECK constraint.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_glossary AS
-- Proposal types from config
SELECT
    'proposal_type'         AS term_category,
    ptc.type                AS term,
    ptc.type                AS display_name,
    ptc.description         AS description,
    NULL::integer           AS sort_order
FROM roadmap_proposal.proposal_type_config ptc
UNION ALL
-- Migration classification vocabulary
SELECT
    'migration_classification'  AS term_category,
    v.term,
    v.display_name,
    v.description,
    v.sort_order
FROM (VALUES
    ('retained',          'Retained',          'Active proposal still being developed; no re-authoring needed',                                              1),
    ('delivered_evidence','Delivered Evidence', 'COMPLETE proposal with verified ACs; referenced as evidence, not re-authored',                             2),
    ('duplicate',         'Duplicate',          'Near-duplicate of another proposal; superseded_by points to canonical',                                    3),
    ('obsolete',          'Obsolete',           'Stale, superseded, or irrelevant; no further action needed',                                               4),
    ('reauthor_needed',   'Re-author Needed',   'Incomplete or misleading record; requires a fresh canonical proposal',                                     5),
    ('superseded',        'Superseded',         'Explicitly replaced by canonical_proposal_id; superseded_by is set',                                       6)
) AS v(term, display_name, description, sort_order)
-- Proposal lifecycle statuses
UNION ALL
SELECT
    'proposal_status'   AS term_category,
    s.term,
    s.display_name,
    s.description,
    s.sort_order
FROM (VALUES
    ('DRAFT',    'Draft',    'Initial idea; architecture and ACs not yet gated',             1),
    ('REVIEW',   'Review',   'Gating review for feasibility and architectural fit',          2),
    ('DEVELOP',  'Develop',  'Building, coding, and testing',                                3),
    ('MERGE',    'Merge',    'Merging branch to main; compatibility and stability focus',    4),
    ('COMPLETE', 'Complete', 'Stable; work verified by ACs and gate decisions',              5),
    ('OBSOLETE', 'Obsolete', 'Superseded or irrelevant; no further lifecycle movement',      6)
) AS s(term, display_name, description, sort_order)
ORDER BY term_category, sort_order NULLS LAST, term;

COMMENT ON VIEW roadmap_proposal.v_doc_glossary IS
    'Vocabulary reference combining proposal type/status/maturity terms with '
    'migration classification definitions. '
    'P995 AC-6 — Glossary documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEW 9: v_doc_verification_matrix
-- AC completion counts per pillar — how many ACs are pass/fail/pending per
-- canonical pillar proposal.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap_proposal.v_doc_verification_matrix AS
SELECT
    p_pillar.id                 AS pillar_id,
    p_pillar.display_id         AS pillar_display_id,
    p_pillar.title              AS pillar_title,
    COUNT(DISTINCT child.id)    AS proposal_count,
    COUNT(ac.id)                AS total_acs,
    COUNT(ac.id) FILTER (WHERE ac.status = 'pass')      AS acs_pass,
    COUNT(ac.id) FILTER (WHERE ac.status = 'fail')      AS acs_fail,
    COUNT(ac.id) FILTER (WHERE ac.status = 'blocked')   AS acs_blocked,
    COUNT(ac.id) FILTER (WHERE ac.status = 'pending')   AS acs_pending,
    ROUND(
        100.0 * COUNT(ac.id) FILTER (WHERE ac.status = 'pass')
        / NULLIF(COUNT(ac.id), 0),
        1
    )                           AS pct_pass
FROM roadmap_proposal.proposal p_pillar
LEFT JOIN roadmap_proposal.proposal child
       ON child.parent_id = p_pillar.id
LEFT JOIN roadmap_proposal.proposal_acceptance_criteria ac
       ON ac.proposal_id = child.id
WHERE p_pillar.parent_id = 1013
GROUP BY p_pillar.id, p_pillar.display_id, p_pillar.title
ORDER BY p_pillar.id;

COMMENT ON VIEW roadmap_proposal.v_doc_verification_matrix IS
    'AC completion counts per pillar: total, pass, fail, blocked, pending, '
    'and percent-pass. Covers direct children of each pillar. '
    'P995 AC-6 — Verification Matrix documentation view. PROJECTION ONLY.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Record migration
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO roadmap.migration_history (filename, checksum_sha256, applied_by, environment, status)
VALUES (
    '128-p995-doc-projection-views.sql',
    'p995-doc-projection-views-9-views-v1',
    'alex/p995-developer',
    'development',
    'applied'
)
ON CONFLICT DO NOTHING;

COMMIT;
