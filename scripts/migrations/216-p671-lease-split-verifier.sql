-- P671: Short-lease default (15m) + split-on-overrun + background e2e verifier
--
-- Three coordinated changes:
-- 1. Add overrun_count and oversized to roadmap.proposal (for split detection)
-- 2. Add e2e_config to roadmap.project (verifier settings)
-- 3. Update proposal_discussions context_prefix check to allow 'lease-overrun' and 'e2e-verify'

-- AC-12: Add columns to track lease overruns and oversized status
ALTER TABLE roadmap_proposal.proposal
ADD COLUMN IF NOT EXISTS overrun_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS oversized BOOLEAN NOT NULL DEFAULT FALSE;

-- AC-5: Extend proposal_discussions context_prefix constraint to include lease-overrun and e2e-verify
ALTER TABLE roadmap_proposal.proposal_discussions
DROP CONSTRAINT IF EXISTS proposal_discussions_context_check;

ALTER TABLE roadmap_proposal.proposal_discussions
ADD CONSTRAINT proposal_discussions_context_check CHECK (
  context_prefix IN (
    'arch:', 'team:', 'critical:', 'security:',
    'general:', 'feedback:', 'concern:', 'poc:', 'decision:',
    'ship-verification:', 'gate-decision:', 'handoff:',
    'lease-overrun', 'e2e-verify', 'e2e-verify-failed'
  )
);

-- Add e2e_config JSONB to project table for verifier settings (default empty)
ALTER TABLE roadmap.project
ADD COLUMN IF NOT EXISTS e2e_config JSONB NOT NULL DEFAULT '{}';
