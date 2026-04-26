/**
 * P476: Widen proposal_reviews.verdict CHECK constraint and add post_gate_change_requirement table
 *
 * Bug: verdict enum too narrow (only approve/request_changes/reject)
 * Fix: Expand to 7 values (add approve_with_changes, send_back, defer, recuse)
 *      Create post_gate_change_requirement table to track conditions from approve_with_changes reviews
 */

-- Drop the existing 3-value CHECK constraint
ALTER TABLE roadmap_proposal.proposal_reviews
  DROP CONSTRAINT proposal_reviews_verdict_check;

-- Add the new 7-value CHECK constraint
ALTER TABLE roadmap_proposal.proposal_reviews
  ADD CONSTRAINT proposal_reviews_verdict_check
  CHECK (verdict = ANY (ARRAY['approve', 'approve_with_changes', 'request_changes', 'send_back', 'reject', 'defer', 'recuse']));

-- Create post_gate_change_requirement table for tracking changes requested by approve_with_changes reviews
CREATE TABLE IF NOT EXISTS roadmap_proposal.post_gate_change_requirement (
  id BIGSERIAL PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES roadmap_proposal.proposal_reviews(id) ON DELETE CASCADE,
  requirement_text TEXT NOT NULL,
  satisfied BOOLEAN DEFAULT FALSE,
  satisfied_at TIMESTAMPTZ,
  satisfied_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_id, requirement_text)
);

-- Index on (satisfied) for next-stage gate to find unsatisfied requirements quickly
CREATE INDEX IF NOT EXISTS pgcr_unsatisfied_idx ON roadmap_proposal.post_gate_change_requirement (satisfied) WHERE satisfied = FALSE;
