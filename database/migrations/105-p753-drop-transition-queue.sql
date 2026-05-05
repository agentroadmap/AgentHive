-- P753 (A6): Retire roadmap_proposal.transition_queue
-- The unified orchestrator (P744/P748-P754) replaces this with
-- the mature queue + proposal_lease pattern.
-- Drop the table and all dependent objects.

-- Pre-flight check: verify no unprocessed rows remain
-- This query should return 0, indicating the queue has been fully drained
-- SELECT COUNT(*) FROM roadmap.transition_queue WHERE processed_at IS NULL;

DROP TABLE IF EXISTS roadmap.transition_queue CASCADE;
