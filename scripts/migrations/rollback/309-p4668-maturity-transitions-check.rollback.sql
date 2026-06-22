-- ============================================================================
-- ROLLBACK: Migration 309 — proposal_maturity_transitions CHECK extensions
-- ============================================================================
-- WARNING: Fails if any rows have transition_reason='canonical','break_glass',
-- or 'compensating_correction', or from/to_maturity='validated'. Delete them first.
-- ============================================================================

BEGIN;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_from_maturity_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_trans_from_check
        CHECK (from_maturity = ANY (ARRAY['new', 'active', 'mature', 'obsolete']));

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_to_maturity_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_trans_to_check
        CHECK (to_maturity = ANY (ARRAY['new', 'active', 'mature', 'obsolete']));

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    DROP CONSTRAINT IF EXISTS proposal_maturity_transitions_transition_reason_check;

ALTER TABLE roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_trans_reason_check
        CHECK (transition_reason = ANY (ARRAY['submit', 'decision', 'system']));

COMMIT;
