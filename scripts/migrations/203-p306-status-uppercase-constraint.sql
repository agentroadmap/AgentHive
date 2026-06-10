-- P306: Normalize Proposal Status Casing (design: docs/design/P306-status-normalization-design.md, Task 1)
-- Migration 203: normalize any remaining title-case status values to UPPERCASE
-- and add a CHECK constraint so mixed-case statuses can never be written again.
--
-- Canonical casing follows workflow_stages.stage_name and
-- proposal_valid_transitions.from_state, which are UPPERCASE.
-- The UPDATEs are idempotent no-ops on already-normalized databases.
--
-- Note: trg_normalize_proposal_status (fn_normalize_proposal_status) already
-- uppercases status on INSERT/UPDATE, so this constraint is a backstop that
-- holds even if that trigger is dropped or disabled.

BEGIN;

-- 1. Normalize title-case statuses to UPPERCASE
UPDATE roadmap_proposal.proposal SET status = 'DRAFT'    WHERE status = 'Draft';
UPDATE roadmap_proposal.proposal SET status = 'REVIEW'   WHERE status = 'Review';
UPDATE roadmap_proposal.proposal SET status = 'DEVELOP'  WHERE status = 'Develop';
UPDATE roadmap_proposal.proposal SET status = 'MERGE'    WHERE status = 'Merge';
UPDATE roadmap_proposal.proposal SET status = 'COMPLETE' WHERE status = 'Complete';

-- 2. Catch-all for any other non-uppercase variant (e.g. legacy 'Deployed')
UPDATE roadmap_proposal.proposal SET status = UPPER(status) WHERE status <> UPPER(status);

-- 3. Prevent future mixed-case inserts/updates
ALTER TABLE roadmap_proposal.proposal
  ADD CONSTRAINT proposal_status_uppercase
  CHECK (status = UPPER(status));

COMMIT;

-- Verification:
--   SELECT status, COUNT(*) FROM roadmap_proposal.proposal GROUP BY status ORDER BY status;
--   Expected: only UPPERCASE values (DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE, ...)
