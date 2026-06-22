-- ============================================================================
-- Migration 315 — P4668 AC-8/AC-15/AC-18/AC-30/AC-31: State reconstruction,
--                 provider-mismatch divergence, and audit views
-- ----------------------------------------------------------------------------
-- Completes the P4668 rollout audit tooling:
--
--   AC-8:  v_p4668_state_reconstruction — per-proposal reconstruction check.
--          For every proposal with canonical ledger entries, the last event's
--          to_status/to_maturity is compared to the live proposal row.
--          Mismatches appear in a quarantine report; consistent rows show
--          reconstruction_status='consistent'.  No mismatched row is silently
--          accepted — this view is the enforcement mechanism.
--
--   AC-15: v_provider_mismatch_events — subset of ledger where provider_mismatch
--          is TRUE, exposing claimed_provider vs resolved_provider divergence.
--          Satisfies AC-15: "a query returns such divergence events."
--
--   AC-18: fn_p4668_backfill_history (defined in mig 310) does not populate
--          resolved_provider or model_used from agency-name prefixes. This
--          migration adds a guard view v_backfill_provider_audit that asserts
--          zero name-inferred provider/model values remain in ledger rows with
--          source_confidence='low'. Operators can query this at any time.
--
--   AC-30: v_p4668_maturity_demotion_audit — quarantine view for any backfill
--          ledger row that would record a maturity demotion from 'validated'
--          to 'new'. The canonical transition operation and backfill function
--          must never silently demote; this view surfaces any violations so
--          operator resolution is explicit.
--
--   AC-31: Documented: actor_host sources AGENTHIVE_HOST env var or
--          agent_registry snapshot; classified source_confidence='medium' when
--          env-sourced (no hard NOT NULL constraint for operator/system events).
--          v_p4668_missing_actor_host exposes spawn-agent/liaison events where
--          actor_host IS NULL so operators can audit coverage.
--
-- ROLLBACK: scripts/migrations/rollback/315-p4668-state-reconstruction.rollback.sql
-- ============================================================================

BEGIN;

-- ── 1. AC-8: State reconstruction view ───────────────────────────────────────
-- Compares the canonical ledger's last-event-per-proposal with the live proposal
-- row. Covers only proposals that have at least one ledger event (the dual-write
-- window means pre-310 proposals have no ledger entries yet; their first new
-- transition will create one).
--
-- reconstruction_status values:
--   'consistent'      — last ledger event matches live proposal row
--   'status_drift'    — to_status != proposal.status (gap or overwrite)
--   'maturity_drift'  — to_maturity != proposal.maturity (gap or overwrite)
--   'both_drift'      — both status and maturity diverged
--   'no_ledger_entry' — proposal has no ledger events yet (normal pre-310)

CREATE OR REPLACE VIEW roadmap_proposal.v_p4668_state_reconstruction AS
WITH last_ledger_event AS (
    SELECT DISTINCT ON (proposal_id)
        proposal_id,
        event_id,
        seq,
        to_status,
        to_maturity,
        event_kind,
        reason_code,
        recorded_at
    FROM roadmap_proposal.proposal_transition_ledger
    WHERE to_status IS NOT NULL OR to_maturity IS NOT NULL
    ORDER BY proposal_id, seq DESC
)
SELECT
    p.id                        AS proposal_id,
    p.display_id,
    p.status                    AS live_status,
    p.maturity                  AS live_maturity,
    lle.to_status               AS ledger_last_status,
    lle.to_maturity             AS ledger_last_maturity,
    lle.event_id                AS last_event_id,
    lle.seq                     AS last_seq,
    lle.event_kind              AS last_event_kind,
    lle.recorded_at             AS last_event_at,

    -- Mismatch flags — a NULL to_status/to_maturity in the ledger means the event
    -- did not change that dimension; in that case we do not flag a mismatch.
    (lle.to_status IS NOT NULL   AND lle.to_status   != p.status)   AS status_mismatch,
    (lle.to_maturity IS NOT NULL AND lle.to_maturity != p.maturity) AS maturity_mismatch,

    -- Scalar quarantine status
    CASE
        WHEN lle.to_status IS NOT NULL   AND lle.to_status   != p.status
         AND lle.to_maturity IS NOT NULL AND lle.to_maturity != p.maturity
            THEN 'both_drift'
        WHEN lle.to_status IS NOT NULL   AND lle.to_status   != p.status
            THEN 'status_drift'
        WHEN lle.to_maturity IS NOT NULL AND lle.to_maturity != p.maturity
            THEN 'maturity_drift'
        ELSE 'consistent'
    END AS reconstruction_status

FROM roadmap_proposal.proposal p
INNER JOIN last_ledger_event lle ON lle.proposal_id = p.id;

COMMENT ON VIEW roadmap_proposal.v_p4668_state_reconstruction IS
    'P4668 AC-8: Per-proposal state reconstruction audit. '
    'Compares the canonical ledger''s last known to_status/to_maturity against the '
    'live proposal row. reconstruction_status=consistent means the ledger correctly '
    'reflects the current state. Drift values (status_drift / maturity_drift / both_drift) '
    'require operator investigation — they may indicate a write that bypassed the ledger. '
    'Proposals with no ledger entries (pre-310) are excluded (INNER JOIN). '
    'Query: SELECT * FROM roadmap_proposal.v_p4668_state_reconstruction '
    'WHERE reconstruction_status != ''consistent'';';

-- Quarantine helper view — only the drift rows
CREATE OR REPLACE VIEW roadmap_proposal.v_p4668_quarantine AS
SELECT *
FROM roadmap_proposal.v_p4668_state_reconstruction
WHERE reconstruction_status != 'consistent';

COMMENT ON VIEW roadmap_proposal.v_p4668_quarantine IS
    'P4668 AC-8: Quarantine report — proposals where the canonical ledger disagrees '
    'with the live proposal row. Each row requires operator resolution. '
    'An empty result is the success state. '
    'Query: SELECT * FROM roadmap_proposal.v_p4668_quarantine;';

GRANT SELECT ON roadmap_proposal.v_p4668_state_reconstruction TO claude, agent_read, agent_write, andy;
GRANT SELECT ON roadmap_proposal.v_p4668_quarantine TO claude, agent_read, agent_write, andy;

-- ── 2. AC-15: Provider-mismatch divergence view ───────────────────────────────
-- Surfaces every ledger event where provider_mismatch=TRUE. Per AC-15, when
-- agent_runs.provider_mismatch is TRUE the canonical event must store BOTH
-- claimed_provider and resolved_provider. This view is the query that "returns
-- such divergence events."

CREATE OR REPLACE VIEW roadmap_proposal.v_provider_mismatch_events AS
SELECT
    ptl.event_id,
    ptl.proposal_id,
    p.display_id,
    ptl.seq,
    ptl.recorded_at,
    ptl.event_kind,
    ptl.actor_principal_id,
    ptl.actor_layer,
    ptl.agent_profile,
    ptl.agency_identity,
    -- Both providers must be non-null when provider_mismatch=TRUE
    ptl.claimed_provider,
    ptl.resolved_provider,
    -- Integrity flag: if one is null when mismatch=TRUE that is itself a bug
    (ptl.claimed_provider  IS NULL) AS flag_missing_claimed_provider,
    (ptl.resolved_provider IS NULL) AS flag_missing_resolved_provider,
    ptl.model_used,
    ptl.route_id,
    ptl.source_confidence,
    ptl.source_surface
FROM roadmap_proposal.proposal_transition_ledger ptl
JOIN roadmap_proposal.proposal p ON p.id = ptl.proposal_id
WHERE ptl.provider_mismatch = TRUE;

COMMENT ON VIEW roadmap_proposal.v_provider_mismatch_events IS
    'P4668 AC-15: Provider-mismatch divergence audit. '
    'Returns every canonical ledger event where provider_mismatch=TRUE, i.e. where '
    'the agent''s claimed_provider differs from the route-resolved resolved_provider. '
    'Both providers must be non-null on mismatch events; flag_missing_* columns expose violations. '
    'The nominal provider token in the agency name is NEVER the authoritative provider (AC-14). '
    'Query: SELECT * FROM roadmap_proposal.v_provider_mismatch_events;';

GRANT SELECT ON roadmap_proposal.v_provider_mismatch_events TO claude, agent_read, agent_write, andy;

-- ── 3. AC-18: Backfill provider-audit guard view ──────────────────────────────
-- Asserts that fn_p4668_backfill_history (mig 310) inserts zero name-inferred
-- provider/model values. The backfill function inserts NULL for resolved_provider
-- and model_used (no column is populated from the agency-name prefix).
-- This view surfaces any violation: a backfill (source_confidence='low') row
-- that somehow has resolved_provider or model_used set.

CREATE OR REPLACE VIEW roadmap_proposal.v_backfill_provider_audit AS
SELECT
    ptl.event_id,
    ptl.proposal_id,
    ptl.seq,
    ptl.recorded_at,
    ptl.actor_principal_id,
    ptl.resolved_provider,
    ptl.model_used,
    ptl.source_surface
FROM roadmap_proposal.proposal_transition_ledger ptl
WHERE ptl.source_confidence = 'low'
  AND (ptl.resolved_provider IS NOT NULL OR ptl.model_used IS NOT NULL);

COMMENT ON VIEW roadmap_proposal.v_backfill_provider_audit IS
    'P4668 AC-18: Backfill provider integrity check. '
    'An empty result is the success state: no low-confidence (backfill) ledger row '
    'has a resolved_provider or model_used set. Any rows here indicate the backfill '
    'function incorrectly inferred provider/model from agency-name or other self-report, '
    'which violates AC-14 and AC-18. '
    'Query: SELECT * FROM roadmap_proposal.v_backfill_provider_audit;';

GRANT SELECT ON roadmap_proposal.v_backfill_provider_audit TO claude, agent_read, agent_write, andy;

-- ── 4. AC-30: Maturity demotion audit view ────────────────────────────────────
-- Per AC-30: backfill reconciliation must never silently demote maturity from
-- 'validated' to 'new'. This view exposes any ledger event that records such a
-- demotion, regardless of whether it came from backfill or a canonical write.
-- The monotonic-maturity invariant (mig 288) says 'validated' is a terminal or
-- reserved state — demoting it is always suspect.

CREATE OR REPLACE VIEW roadmap_proposal.v_p4668_maturity_demotion_audit AS
SELECT
    ptl.event_id,
    ptl.proposal_id,
    p.display_id,
    ptl.seq,
    ptl.recorded_at,
    ptl.from_maturity,
    ptl.to_maturity,
    ptl.event_kind,
    ptl.reason_code,
    ptl.actor_principal_id,
    ptl.source_confidence,
    ptl.source_surface,
    -- Classify the severity
    CASE
        WHEN ptl.from_maturity = 'validated' AND ptl.to_maturity = 'new'
            THEN 'critical'   -- validated → new is a direct demotion
        WHEN ptl.from_maturity = 'validated'
            THEN 'warning'    -- validated → any other lower maturity
        ELSE 'info'
    END AS demotion_severity
FROM roadmap_proposal.proposal_transition_ledger ptl
JOIN roadmap_proposal.proposal p ON p.id = ptl.proposal_id
WHERE ptl.from_maturity = 'validated'
  AND ptl.to_maturity IS NOT NULL
  AND ptl.to_maturity != 'validated';

COMMENT ON VIEW roadmap_proposal.v_p4668_maturity_demotion_audit IS
    'P4668 AC-30: Maturity demotion audit. '
    'Exposes any canonical ledger event that records a maturity demotion from the '
    '''validated'' state. An empty result is the success state. '
    'The monotonic-maturity invariant (mig 288) marks ''validated'' as a high-bar state '
    'whose demotion must be operator-explicit, not silent. '
    'severity=critical: validated→new (worst case, matches AC-30 concern). '
    'severity=warning: validated→anything-else. '
    'Query: SELECT * FROM roadmap_proposal.v_p4668_maturity_demotion_audit;';

GRANT SELECT ON roadmap_proposal.v_p4668_maturity_demotion_audit TO claude, agent_read, agent_write, andy;

-- ── 5. AC-31: Missing actor_host audit view ───────────────────────────────────
-- actor_host is documented as sourced from AGENTHIVE_HOST env var or agent_registry
-- snapshot, classified source_confidence='medium' when env-sourced. The DB does NOT
-- enforce NOT NULL for all layers (operator/system events may not have a host).
-- For spawn-agent and liaison events, actor_host SHOULD always be populated.
-- This view exposes gaps for operator review.

CREATE OR REPLACE VIEW roadmap_proposal.v_p4668_missing_actor_host AS
SELECT
    ptl.event_id,
    ptl.proposal_id,
    p.display_id,
    ptl.seq,
    ptl.recorded_at,
    ptl.actor_principal_id,
    ptl.actor_layer,
    ptl.agent_profile,
    ptl.source_confidence,
    ptl.source_surface
FROM roadmap_proposal.proposal_transition_ledger ptl
JOIN roadmap_proposal.proposal p ON p.id = ptl.proposal_id
WHERE ptl.actor_host IS NULL
  AND ptl.actor_layer IN ('spawn-agent', 'liaison');

COMMENT ON VIEW roadmap_proposal.v_p4668_missing_actor_host IS
    'P4668 AC-31: actor_host coverage audit for spawn-agent and liaison events. '
    'Per AC-31, actor_host should be populated from AGENTHIVE_HOST env var or '
    'agent_registry snapshot (source_confidence=medium when env-sourced). '
    'Rows here indicate events where the host was not captured at write time. '
    'This is expected for backfill rows (source_confidence=low) and for events '
    'written before the canonical-transition.ts caller started reading AGENTHIVE_HOST. '
    'Goal: zero rows for events after the canonical-transition.ts host-population PR. '
    'Query: SELECT * FROM roadmap_proposal.v_p4668_missing_actor_host;';

GRANT SELECT ON roadmap_proposal.v_p4668_missing_actor_host TO claude, agent_read, agent_write, andy;

COMMIT;
