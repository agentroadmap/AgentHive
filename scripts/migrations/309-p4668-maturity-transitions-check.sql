-- ============================================================================
-- Migration 309 — P4668 AC-9: Extend proposal_maturity_transitions CHECKs
-- ----------------------------------------------------------------------------
-- 1. Add 'validated' to from_maturity and to_maturity CHECK vocabularies.
--    'validated' is used for gated maturity states in the P3563/P4668 pipeline.
-- 2. Add 'canonical','break_glass','compensating_correction' to transition_reason.
--    'canonical' = new default write path (fn_canonical_transition_insert).
--    'break_glass' = operator emergency override.
--    'compensating_correction' = correction event for prior misrecord.
--
-- ORDERING: Additive; no dependencies beyond mig 306.
-- ROLLBACK:  scripts/migrations/rollback/309-p4668-maturity-transitions-check.rollback.sql
-- ============================================================================

BEGIN;

-- ── from_maturity ────────────────────────────────────────────────────────────
-- Live baseline name: proposal_maturity_trans_from_check
-- Extended name (if mig was partially applied): proposal_maturity_transitions_from_maturity_check

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_trans_from_check;
ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_from_maturity_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_transitions_from_maturity_check
        CHECK (from_maturity = ANY (ARRAY[
            'new', 'active', 'mature', 'obsolete',
            'validated'
        ]));

-- ── to_maturity ──────────────────────────────────────────────────────────────
ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_trans_to_check;
ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_to_maturity_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_transitions_to_maturity_check
        CHECK (to_maturity = ANY (ARRAY[
            'new', 'active', 'mature', 'obsolete',
            'validated'
        ]));

-- ── transition_reason ────────────────────────────────────────────────────────
ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_trans_reason_check;
ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_transition_reason_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_transitions_transition_reason_check
        CHECK (transition_reason = ANY (ARRAY[
            'submit', 'decision', 'system',
            'canonical', 'break_glass', 'compensating_correction'
        ]));

COMMIT;
