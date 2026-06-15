-- 283-p1391-lease-ttl-structural-rollback.sql
-- P1391 (AC-16): inverse of 283-p1391-lease-ttl-structural.sql.
--
-- Restores the previous uniqueness lock WITHOUT admitting overlapping live
-- leases (AC-16): the EXCLUDE is dropped and the original
-- proposal_lease_one_active UNIQUE NULLS NOT DISTINCT is re-added — that
-- constraint still forbids two simultaneously-unreleased leases, so no
-- overlapping live leases can sneak in during the rollback window.
--
-- This migration touched ONLY the structural lease layer (AC-30); it did NOT
-- modify the P704 trigger CASE or gate_decision_log, so this rollback does not
-- need to revert those (the deferred AC-31 verdict slice owns them).
--
-- Idempotent. No inner BEGIN/COMMIT (runner wraps).
--
-- NOTE ON BACKFILL (Change 1 / AC-21): the expired-unreleased leases closed by
-- the forward migration retain release_reason='lease_expired'. Un-releasing
-- them would re-poison the claim pool, so they are deliberately LEFT released
-- on rollback. The maturity values were preserved (trigger was suppressed), so
-- no maturity correction is required.

-- ---------------------------------------------------------------------------
-- Reverse AC-11/AC-2 — drop the EXCLUDE, re-add the UNIQUE lock.
-- ---------------------------------------------------------------------------
ALTER TABLE roadmap_proposal.proposal_lease
  DROP CONSTRAINT IF EXISTS proposal_lease_no_overlap_live;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_one_active'
  ) THEN
    ALTER TABLE roadmap_proposal.proposal_lease
      ADD CONSTRAINT proposal_lease_one_active
      UNIQUE NULLS NOT DISTINCT (proposal_id, released_at);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Reverse AC-20 — restore the is_active generated column and the two views
-- to their pre-P1391 form (plain `released_at IS NULL`).
-- ---------------------------------------------------------------------------
ALTER TABLE roadmap_proposal.proposal_lease
  ADD COLUMN IF NOT EXISTS is_active boolean
  GENERATED ALWAYS AS (released_at IS NULL) STORED;

CREATE OR REPLACE VIEW roadmap.proposal_lease AS
  SELECT id, proposal_id, agent_identity, claimed_at, expires_at,
         released_at, release_reason, is_active
    FROM roadmap_proposal.proposal_lease;

CREATE OR REPLACE VIEW roadmap_proposal.claim_log AS
  SELECT l.id AS claim_id,
         l.proposal_id,
         p.display_id,
         l.agent_identity,
         l.claimed_at,
         l.expires_at,
         l.released_at,
         l.release_reason,
         l.is_active,
         CASE
           WHEN l.released_at IS NOT NULL THEN 'released'::text
           WHEN l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'expired'::text
           ELSE 'active'::text
         END AS claim_status
    FROM roadmap_proposal.proposal_lease l
    JOIN roadmap_proposal.proposal p ON p.id = l.proposal_id;

-- ---------------------------------------------------------------------------
-- Reverse AC-25 — drop the max-TTL CHECK.
-- ---------------------------------------------------------------------------
ALTER TABLE roadmap_proposal.proposal_lease
  DROP CONSTRAINT IF EXISTS proposal_lease_max_ttl_check;

-- ---------------------------------------------------------------------------
-- Reverse AC-12 — leave expires_at NOT NULL + DEFAULT in place. The live
-- column was ALREADY NOT NULL DEFAULT before P1391 (the forward migration only
-- re-asserted it), so reverting NULLability would regress below the pre-P1391
-- baseline. Intentionally a no-op. Uncomment only if a true pre-baseline state
-- is required:
-- ALTER TABLE roadmap_proposal.proposal_lease
--   ALTER COLUMN expires_at DROP NOT NULL,
--   ALTER COLUMN expires_at DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Reverse AC-22 — drop the lease_is_live function (views above already
-- reverted to not reference it).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS roadmap_proposal.lease_is_live(timestamptz, timestamptz);
