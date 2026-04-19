-- P281 Phase 1: Resource hierarchy — pull-based offer/claim/lease dispatch.
--
-- Extends squad_dispatch with offer lifecycle (open → claimed → active →
-- delivered/expired/failed) and proposal_lease with renewal tracking.
-- Enables atomic claiming via SELECT FOR UPDATE SKIP LOCKED in subsequent
-- migrations (functions land in 039).
--
-- Scope: schema only. No data migration needed for new columns; existing
-- dispatch rows default to offer_status='delivered' so they don't appear
-- as open offers to providers.

BEGIN;

-- (1) squad_dispatch — relax agent_identity NOT NULL to allow empty-string
--     placeholder while offer is open (no claimant yet). Empty string + NOT
--     NULL keeps FK semantics simple (no nullable joins downstream).
ALTER TABLE roadmap_workforce.squad_dispatch
  ALTER COLUMN agent_identity SET DEFAULT '';

-- (2) squad_dispatch — add offer lifecycle columns
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS offer_status TEXT NOT NULL DEFAULT 'delivered'
    CHECK (offer_status IN ('open','claimed','active','delivered','expired','failed')),
  ADD COLUMN IF NOT EXISTS claim_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renew_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reissue_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_reissues INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS required_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS offer_version INT NOT NULL DEFAULT 1;

-- (3) Relax dispatch_status check to accept 'open' and 'failed'
ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT IF EXISTS squad_dispatch_status_check;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_status_check
  CHECK (dispatch_status IN ('open','assigned','active','completed','blocked','cancelled','failed'));

-- (4) Polling index — providers scan open offers ordered by assigned_at
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_offer_poll
  ON roadmap_workforce.squad_dispatch (offer_status, assigned_at)
  WHERE offer_status = 'open';

-- (5) Reaper index — find claimed/active offers whose claim has expired
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_claim_expiry
  ON roadmap_workforce.squad_dispatch (claim_expires_at)
  WHERE offer_status IN ('claimed','active') AND claim_expires_at IS NOT NULL;

-- (6) proposal_lease — renewal tracking
ALTER TABLE roadmap_proposal.proposal_lease
  ADD COLUMN IF NOT EXISTS lease_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS renewed_count INT NOT NULL DEFAULT 0;

COMMIT;
