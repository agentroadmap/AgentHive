-- P468: Proposal lease renewal — non-stuck agents requesting more time
-- First 2 renewals are auto-approved by Liaison; 3rd requires operator approval.

CREATE TABLE IF NOT EXISTS roadmap.proposal_lease_renewal (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  briefing_id uuid NOT NULL,
  proposal_id bigint,
  agency_id text NOT NULL,
  renewal_count int NOT NULL DEFAULT 1 CHECK (renewal_count BETWEEN 1 AND 3),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  approved_by text,               -- 'liaison' (auto) | operator identity
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  new_expires_at timestamptz      -- populated when approved
);

CREATE INDEX IF NOT EXISTS lease_renewal_briefing_idx
  ON roadmap.proposal_lease_renewal (briefing_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS lease_renewal_pending_idx
  ON roadmap.proposal_lease_renewal (agency_id, status)
  WHERE status = 'pending';

COMMENT ON TABLE roadmap.proposal_lease_renewal IS
'Tracks lease extension requests from non-stuck agents needing more time.
Max 3 renewals per briefing. First 2 auto-approved by Liaison; 3rd requires operator.';
