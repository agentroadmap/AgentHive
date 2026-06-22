-- ============================================================================
-- Migration 311 — P4668 AC-22/AC-23/AC-24/AC-28: Direct-write enforcement
-- ----------------------------------------------------------------------------
-- Step 6 of 8 in the P4668 rollout:
--   306: ledger DDL + fn_canonical_transition_insert
--   307: ledger_event_id FK on proposal_event
--   308: extend proposal_event event_type CHECK
--   309: extend proposal_maturity_transitions CHECKs
--   310: dual-write shim (shadow trigger) + divergence view + backfill
--   311: enforce direct-write denial                          ← THIS FILE
--   312: break-glass role + function
--   313: unified timeline view
--
-- PRE-FLIGHT REQUIREMENT:
--   All TypeScript callers must be migrated to use fn_canonical_transition_insert()
--   before applying this migration. Verify zero divergence first:
--     SELECT * FROM roadmap_proposal.v_enforcement_preflight;
--   enforcement_safe must be TRUE. If it is FALSE, do not apply — fix the
--   divergent writers, re-run fn_p4668_backfill_history(), then re-check.
--
-- PURPOSE:
--   1. REVOKE INSERT on proposal_transition_ledger from application roles.
--      After this migration only fn_canonical_transition_insert() (SECURITY
--      DEFINER, owned by the postgres superuser role) may insert rows.
--      Direct INSERT from application sessions raises "permission denied."
--
--   2. Install v_enforcement_preflight — a CI-queryable readiness view so
--      operators can confirm zero divergence before toggling enforcement.
--
--   3. AC-24 documentation: fn_sync_proposal_maturity + fn_apply_gate_advance
--      are explicitly EXCLUDED from canonical-ledger enforcement with written
--      rationale (see COMMENT block below). Their callers are responsible for
--      emitting the corresponding canonical event.
--
--   4. AC-28: Confirm no trigger writes canonical ledger rows directly.
--      trg_shadow_write_to_ledger (mig 310) on proposal_state_transitions is
--      the sole DB-layer writer — it is explicitly authorised as the dual-write
--      shim and will be retired in a later migration when the TS layer is fully
--      migrated.
--
-- ROLLBACK: scripts/migrations/rollback/311-p4668-enforcement.rollback.sql
-- ============================================================================

BEGIN;

-- ── 1. REVOKE INSERT from application roles (AC-23) ──────────────────────────
-- Roles claude, andy, admin_write, and agent_write had INSERT granted in mig 306
-- to allow the dual-write window to operate. After all TypeScript writers are
-- migrated, we revoke it so only the SECURITY DEFINER function can insert.

REVOKE INSERT ON roadmap_proposal.proposal_transition_ledger
    FROM claude, andy, admin_write, agent_write;

-- ── 2. Update table comment to reflect enforcement status (AC-1/AC-23) ────────
COMMENT ON TABLE roadmap_proposal.proposal_transition_ledger IS
    'P4668 AC-1/AC-23: Append-only canonical event ledger (enforcement ACTIVE since mig 311). '
    'INSERT is REVOKED from all application roles (claude, andy, admin_write, agent_write). '
    'Only roadmap.fn_canonical_transition_insert(JSONB) (SECURITY DEFINER) may insert. '
    'Corrections require a compensating_correction event — UPDATE and DELETE are permanently '
    'REVOKED from all application roles (mig 306). '
    'Emergency inserts: fn_canonical_transition_break_glass() (mig 312, operator-only).';

-- ── 3. Pre-flight readiness view (AC-9/AC-23) ─────────────────────────────────
-- Operators query this BEFORE applying this migration to confirm zero divergence.
-- Also used post-enforcement to detect any regressions in dual-write coverage.

CREATE OR REPLACE VIEW roadmap_proposal.v_enforcement_preflight AS
SELECT
    COUNT(*) FILTER (WHERE flag_missing_in_ledger)   AS missing_in_ledger_count,
    COUNT(*) FILTER (WHERE flag_from_status_mismatch) AS from_mismatch_count,
    COUNT(*) FILTER (WHERE flag_to_status_mismatch)   AS to_mismatch_count,
    COUNT(*)                                          AS total_pst_rows,
    (
        COUNT(*) FILTER (WHERE flag_missing_in_ledger)    = 0
        AND COUNT(*) FILTER (WHERE flag_from_status_mismatch) = 0
        AND COUNT(*) FILTER (WHERE flag_to_status_mismatch)   = 0
    ) AS enforcement_safe
FROM roadmap_proposal.v_dual_write_divergence;

COMMENT ON VIEW roadmap_proposal.v_enforcement_preflight IS
    'P4668 AC-9/AC-23: Pre-flight check for mig 311 enforcement. '
    'enforcement_safe=TRUE means zero divergence — safe to apply REVOKE INSERT. '
    'Usage: SELECT * FROM roadmap_proposal.v_enforcement_preflight; '
    'If enforcement_safe=FALSE, call fn_p4668_backfill_history(false, 500) then re-check. '
    'Post-enforcement: monitor for regressions (new PST rows not shadow-written to ledger).';

GRANT SELECT ON roadmap_proposal.v_enforcement_preflight
    TO claude, agent_read, agent_write, andy;

-- ── 4. AC-24: fn_sync_proposal_maturity + fn_apply_gate_advance exclusion ─────
-- These DB functions are EXCLUDED from direct canonical-ledger enforcement.
-- Their exclusion is intentional and documented here as the authoritative record.
--
-- fn_sync_proposal_maturity (first defined in mig ~215):
--   - Resets proposal.maturity to 'new' when proposal.status changes.
--   - Does NOT write to any ledger table. The maturity reset is represented
--     in the canonical ledger as a 'maturity_reset_on_status_change' event,
--     which the CALLING TypeScript operation (canonical-transition.ts) must
--     emit immediately after the status-transition event.
--   - TypeScript caller pattern:
--       await canonicalTransition(db, { event_kind: 'status_transition', ... })
--       await canonicalTransition(db, { event_kind: 'maturity_reset_on_status_change', ... })
--
-- fn_apply_gate_advance (last rewritten in mig 299):
--   - Fires AFTER INSERT on gate_decision_log; auto-advances proposal.status.
--   - Uses SET LOCAL app.gate_bypass='true' to avoid fn_guard_gate_advance deadlock.
--   - EXCLUSION RATIONALE (AC-22): The gate_decision_log INSERT IS already
--     the authoritative canonical event for a gate advance. The canonical ledger
--     event for a gate advance must be written by the TypeScript gate-evaluator
--     BEFORE calling record_gate_decision(), so that the ledger event_id can be
--     stored in the gate_decision_log row. After mig 311 the contract is:
--       1. gate-evaluator.ts calls canonicalTransition() → gets event_id.
--       2. gate-evaluator.ts calls record_gate_decision(event_id, ...).
--       3. fn_apply_gate_advance fires; proposal.status advances.
--     The gate_bypass SET LOCAL used inside fn_apply_gate_advance cannot be
--     exploited by application code to write a canonical ledger row because
--     INSERT on proposal_transition_ledger is now revoked. AC-22 is satisfied:
--     no non-canonical caller can circumvent the guard.

-- Stamp the exclusion decision as a table comment so it survives code churn.
COMMENT ON FUNCTION roadmap.fn_shadow_write_to_ledger() IS
    'P4668 mig-310/311: SECURITY DEFINER trigger function — the ONLY DB-layer writer to '
    'proposal_transition_ledger apart from fn_canonical_transition_insert(). '
    'Fires AFTER INSERT on proposal_state_transitions during the dual-write window. '
    'Will be retired when TypeScript layer is fully migrated to fn_canonical_transition_insert(). '
    'AC-24/AC-28: fn_sync_proposal_maturity and fn_apply_gate_advance do NOT write to the '
    'ledger directly; their callers emit canonical events via canonical-transition.ts.';

COMMIT;
