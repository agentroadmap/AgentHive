-- Migration 017: worktree_merge_log table for P148
-- Tracks merge attempts, conflicts, and successful merges for proposals

CREATE TABLE IF NOT EXISTS roadmap.worktree_merge_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id BIGINT NOT NULL REFERENCES roadmap.proposal(id) ON DELETE CASCADE,
    commit_sha TEXT,
    status TEXT NOT NULL CHECK (status IN ('merged', 'conflict', 'failed', 'pending')),
    conflict_files JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by proposal
CREATE INDEX IF NOT EXISTS idx_worktree_merge_log_proposal
    ON roadmap.worktree_merge_log(proposal_id, created_at DESC);

-- Grant access to the agent role
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.worktree_merge_log TO agent;

-- Grant select to public for read-only access
GRANT SELECT ON roadmap.worktree_merge_log TO PUBLIC;
