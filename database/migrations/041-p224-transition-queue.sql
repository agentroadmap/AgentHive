/**
 * P224 — State transitions require active lease to prevent duplicate gating
 *
 * Creates transition_queue table to track pending state transitions and enforce:
 * - AC-4: transition_queue has `claimed_by` column; processing agent must match
 * - AC-5: UNIQUE constraint on (proposal_id, from_stage, to_stage, status) prevents duplicate pending entries
 * - AC-6: Stale claims (>10 min) auto-released by periodic cleanup (application-level)
 */

-- Create transition_queue table
CREATE TABLE IF NOT EXISTS roadmap_proposal.transition_queue (
    id BIGSERIAL PRIMARY KEY,
    proposal_id BIGINT NOT NULL REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
    from_stage TEXT NOT NULL,
    to_stage TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    claimed_by TEXT REFERENCES agent_registry(agent_identity) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT
);

-- AC-5: Create partial unique constraint to prevent duplicate pending entries
-- PostgreSQL partial unique indexes enforce uniqueness only for matching rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_transition_queue_pending_unique
    ON roadmap_proposal.transition_queue(proposal_id, from_stage, to_stage)
    WHERE status = 'pending';

-- Index for efficient filtering by proposal_id and status
CREATE INDEX IF NOT EXISTS idx_transition_queue_proposal_status ON roadmap_proposal.transition_queue(proposal_id, status);

-- Index for finding stale processing entries (for AC-6 cleanup)
CREATE INDEX IF NOT EXISTS idx_transition_queue_stale_processing ON roadmap_proposal.transition_queue(processing_started_at)
    WHERE status = 'processing' AND processing_started_at IS NOT NULL;

-- Comment documenting the purpose and lease requirement
COMMENT ON TABLE roadmap_proposal.transition_queue IS 'P224: Queue for pending state transitions. claimed_by must hold active lease on proposal_id. AC-5: UNIQUE constraint prevents duplicate pending entries.';
COMMENT ON COLUMN roadmap_proposal.transition_queue.claimed_by IS 'Agent that claimed this transition. Must hold active lease on proposal_id. (P224 AC-4)';
COMMENT ON COLUMN roadmap_proposal.transition_queue.status IS 'pending (new entry), processing (claimed_by is working), completed/failed (terminal states)';
