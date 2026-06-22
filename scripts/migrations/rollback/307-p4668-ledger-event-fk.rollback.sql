-- ============================================================================
-- ROLLBACK: Migration 307 — ledger_event_id FK on proposal_event
-- ============================================================================

BEGIN;

ALTER TABLE roadmap_proposal.proposal_event
    DROP CONSTRAINT IF EXISTS fk_proposal_event_ledger;

DROP INDEX IF EXISTS roadmap_proposal.idx_proposal_event_ledger_event_id;

ALTER TABLE roadmap_proposal.proposal_event
    DROP COLUMN IF EXISTS ledger_event_id;

COMMIT;
