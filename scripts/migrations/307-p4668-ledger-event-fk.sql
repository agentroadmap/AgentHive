-- ============================================================================
-- Migration 307 — P4668 AC-12/AC-36: ledger_event_id FK on proposal_event
-- ----------------------------------------------------------------------------
-- Adds a nullable foreign key from proposal_event → proposal_transition_ledger
-- so each proposal_event row can be correlated with its ledger event.
--
-- Nullable: legacy proposal_event rows predate the ledger and have no entry.
-- Populated by canonical-transition.ts in the dual-write phase (mig 310).
--
-- ORDERING: Must follow mig 306 (ledger table must exist).
-- ROLLBACK:  scripts/migrations/rollback/307-p4668-ledger-event-fk.rollback.sql
-- ============================================================================

BEGIN;

ALTER TABLE roadmap_proposal.proposal_event
    ADD COLUMN IF NOT EXISTS ledger_event_id UUID;

COMMENT ON COLUMN roadmap_proposal.proposal_event.ledger_event_id IS
    'P4668 AC-12: FK to proposal_transition_ledger.event_id. '
    'NULL for legacy events predating mig-306. '
    'Populated by canonical-transition.ts for all new events.';

-- Deferred FK: proposal_event rows can be inserted before the ledger row
-- commits in complex transaction sequences.
ALTER TABLE roadmap_proposal.proposal_event
    ADD CONSTRAINT fk_proposal_event_ledger
        FOREIGN KEY (ledger_event_id)
        REFERENCES roadmap_proposal.proposal_transition_ledger(event_id)
        DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_proposal_event_ledger_event_id
    ON roadmap_proposal.proposal_event (ledger_event_id)
    WHERE ledger_event_id IS NOT NULL;

COMMIT;
