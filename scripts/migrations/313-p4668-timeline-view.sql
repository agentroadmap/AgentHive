-- ============================================================================
-- Migration 313 — P4668 AC-10/AC-17: Unified who-did-what timeline view
-- ----------------------------------------------------------------------------
-- Step 8 of 8 in the P4668 rollout (final):
--   306: ledger DDL + fn_canonical_transition_insert
--   307: ledger_event_id FK on proposal_event
--   308: extend proposal_event event_type CHECK
--   309: extend proposal_maturity_transitions CHECKs
--   310: dual-write shim (shadow trigger) + divergence view + backfill
--   311: enforce direct-write denial
--   312: break-glass role + function
--   313: unified timeline view                                ← THIS FILE
--
-- PURPOSE:
--   AC-10: Single queryable timeline per proposal combining all sources of
--          who-did-what (canonical ledger, gate decisions, reviews, dispatches).
--   AC-17: Timeline exposes resolved_provider + model_used at per-event
--          granularity for provider+model attribution audits.
--
-- DESIGN:
--   v_proposal_unified_timeline is a UNION ALL over:
--     1. Canonical ledger rows (highest confidence — 'high')
--     2. Gate decisions not yet mirrored in ledger ('high' confidence, no event_id)
--     3. Review verdicts not yet mirrored in ledger ('medium' confidence)
--     4. Agent dispatch rows from agent_runs not yet mirrored ('medium' confidence)
--   The "orphan" streams are gap-fillers for the dual-write window. Once all
--   TypeScript callers emit canonical events they will naturally yield zero
--   orphan rows and the UNION will collapse to ledger rows only.
--
--   Filter by proposal_id for per-proposal timeline.
--   Filter by resolved_provider IS NOT NULL for AC-17 attribution analysis.
--   Filter by confidence='high' for audit-grade queries.
--
-- ROLLBACK: scripts/migrations/rollback/313-p4668-timeline-view.rollback.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_unified_timeline AS
WITH
-- ── Source 1: Canonical ledger (AC-10 primary, highest trust) ─────────────────
ledger_events AS (
    SELECT
        ptl.event_id,
        ptl.proposal_id,
        ptl.seq,
        ptl.recorded_at                  AS timeline_at,
        'ledger'::text                   AS timeline_source,
        'high'::text                     AS confidence,
        ptl.event_kind                   AS activity_type,
        ptl.from_status,
        ptl.to_status,
        ptl.from_maturity,
        ptl.to_maturity,
        ptl.actor_principal_id,
        ptl.actor_layer,
        ptl.agent_profile,
        ptl.agency_identity,
        -- AC-17: Axis 3 provider+model at event granularity
        ptl.resolved_provider,
        ptl.claimed_provider,
        ptl.provider_mismatch,
        ptl.model_used,
        ptl.route_id,
        ptl.actor_host,
        ptl.source_surface,
        ptl.rationale,
        ptl.source_confidence
    FROM roadmap_proposal.proposal_transition_ledger ptl
),

-- ── Source 2: Gate decisions not yet canonically recorded (AC-10 gap-fill) ────
-- A gate decision that happened within 10s of an existing ledger status-transition
-- is assumed to be the same event already canonical. Others are surfaced as orphans.
orphan_gate_decisions AS (
    SELECT
        NULL::uuid                       AS event_id,
        gdl.proposal_id,
        NULL::bigint                     AS seq,
        gdl.created_at                   AS timeline_at,
        'gate_decision'::text            AS timeline_source,
        'high'::text                     AS confidence,
        ('gate_' || gdl.decision)::text  AS activity_type,
        gdl.from_state                   AS from_status,
        gdl.to_state                     AS to_status,
        NULL::text                       AS from_maturity,
        NULL::text                       AS to_maturity,
        gdl.decided_by                   AS actor_principal_id,
        'gating-agent'::text             AS actor_layer,
        NULL::text                       AS agent_profile,
        COALESCE(gdl.authority_agent, gdl.decided_by) AS agency_identity,
        NULL::text                       AS resolved_provider,
        NULL::text                       AS claimed_provider,
        NULL::boolean                    AS provider_mismatch,
        NULL::text                       AS model_used,
        gdl.id::bigint                   AS route_id,
        NULL::text                       AS actor_host,
        'gate_decision_log'::text        AS source_surface,
        gdl.rationale,

        'medium'::text                   AS source_confidence
    FROM roadmap_proposal.gate_decision_log gdl
    WHERE NOT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_transition_ledger ptl
        WHERE ptl.proposal_id = gdl.proposal_id
          AND ptl.event_kind IN ('gate_transition', 'status_transition', 'gate_decision')
          AND ABS(EXTRACT(EPOCH FROM (ptl.recorded_at - gdl.created_at))) < 10
    )
),

-- ── Source 3: Review verdicts not yet canonically recorded ────────────────────
orphan_reviews AS (
    SELECT
        NULL::uuid                       AS event_id,
        pr.proposal_id,
        NULL::bigint                     AS seq,
        pr.reviewed_at                   AS timeline_at,
        'review'::text                   AS timeline_source,
        'medium'::text                   AS confidence,
        'review_submitted'::text         AS activity_type,
        NULL::text                       AS from_status,
        NULL::text                       AS to_status,
        NULL::text                       AS from_maturity,
        NULL::text                       AS to_maturity,
        pr.reviewer_identity             AS actor_principal_id,
        'reviewer'::text                 AS actor_layer,
        NULL::text                       AS agent_profile,
        pr.reviewer_identity             AS agency_identity,
        NULL::text                       AS resolved_provider,
        NULL::text                       AS claimed_provider,
        NULL::boolean                    AS provider_mismatch,
        NULL::text                       AS model_used,
        pr.id::bigint                    AS route_id,
        NULL::text                       AS actor_host,
        'proposal_reviews'::text         AS source_surface,
        pr.verdict || COALESCE(': ' || LEFT(pr.notes, 200), '') AS rationale,

        'low'::text                      AS source_confidence
    FROM roadmap_proposal.proposal_reviews pr
    WHERE NOT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_transition_ledger ptl
        WHERE ptl.proposal_id = pr.proposal_id
          AND ptl.event_kind = 'review_submitted'
          AND ABS(EXTRACT(EPOCH FROM (ptl.recorded_at - pr.reviewed_at))) < 10
    )
),

-- ── Source 4: Agent dispatches from agent_runs (AC-17 provider+model data) ───
-- Only surface dispatches that haven't been emitted canonically yet.
orphan_dispatches AS (
    SELECT
        NULL::uuid                       AS event_id,
        ar.proposal_id,
        NULL::bigint                     AS seq,
        ar.started_at                    AS timeline_at,
        'dispatch'::text                 AS timeline_source,
        'medium'::text                   AS confidence,
        'agent_dispatched'::text         AS activity_type,
        NULL::text                       AS from_status,
        NULL::text                       AS to_status,
        NULL::text                       AS from_maturity,
        NULL::text                       AS to_maturity,
        COALESCE(ar.agency_identity, ar.agent_identity) AS actor_principal_id,
        'spawn-agent'::text              AS actor_layer,
        ar.stage                         AS agent_profile,
        COALESCE(ar.agency_identity, ar.agent_identity) AS agency_identity,
        -- AC-17: resolved_provider + model_used from agent_runs (authoritative per AC-14)
        ar.resolved_provider,
        ar.claimed_provider,
        ar.provider_mismatch,
        ar.model_used,
        ar.route_id,
        NULL::text                       AS actor_host,
        'agent_runs'::text               AS source_surface,
        ar.activity                      AS rationale,

        'medium'::text                   AS source_confidence
    FROM roadmap_workforce.agent_runs ar
    WHERE ar.proposal_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM roadmap_proposal.proposal_transition_ledger ptl
          WHERE ptl.proposal_id = ar.proposal_id
            AND ptl.event_kind IN ('dispatch', 'agent_dispatched')
            AND ABS(EXTRACT(EPOCH FROM (ptl.recorded_at - ar.started_at))) < 10
      )
)

SELECT * FROM ledger_events
UNION ALL
SELECT * FROM orphan_gate_decisions
UNION ALL
SELECT * FROM orphan_reviews
UNION ALL
SELECT * FROM orphan_dispatches;

COMMENT ON VIEW roadmap_proposal.v_proposal_unified_timeline IS
    'P4668 AC-10/AC-17: Unified who-did-what timeline per proposal, ordered by timeline_at DESC. '
    'PRIMARY: ledger rows (timeline_source=ledger, confidence=high) from proposal_transition_ledger — '
    'these are the canonical record with full three-axis actor identity. '
    'GAP-FILL: orphan rows from gate_decision_log (confidence=high), proposal_reviews (medium), '
    'and agent_runs (medium) cover the dual-write transition window. Once all TypeScript callers '
    'emit canonical events the orphan streams will yield zero rows naturally. '
    'AC-17: Filter WHERE resolved_provider IS NOT NULL for provider+model attribution audit. '
    'AC-10: Filter WHERE proposal_id = $1 ORDER BY timeline_at DESC for per-proposal history. '
    'AUDIT-GRADE: Filter WHERE confidence=''high'' AND timeline_source=''ledger'' for immutable records only.';

GRANT SELECT ON roadmap_proposal.v_proposal_unified_timeline
    TO claude, agent_read, agent_write, andy;

COMMIT;
