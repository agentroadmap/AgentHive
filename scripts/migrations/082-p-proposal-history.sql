-- P-proposal-history: index for efficient version lookup
-- The proposal_version table already exists; this migration adds the index
-- that makes DESC history queries O(log n) per proposal.
CREATE INDEX IF NOT EXISTS proposal_version_by_proposal
  ON roadmap_proposal.proposal_version (proposal_id, version_number DESC);
