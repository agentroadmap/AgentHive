-- 283-p1391-lease-ttl-structural.sql
-- P1391: Lease lifecycle as TTL — STRUCTURAL LEASE LAYER ONLY (AC-30 scope).
--
-- Implements the operator's clarified model: the proposal_lease is the
-- concurrency lock and uses TTL expiry as automatic release. A lease is
-- *alive* iff `released_at IS NULL AND expires_at > NOW()`. Natural TTL
-- expiry IS the release; no janitor/reaper needed.
--
-- IN SCOPE (AC-30): AC-1, AC-2, AC-3, AC-8/AC-15, AC-9, AC-11, AC-12,
--   AC-20, AC-22, AC-24 (structural preflight only), AC-25, AC-13/AC-21
--   (backfill of expired-unreleased leases preserving phase maturity).
--
-- EXPLICITLY OUT OF SCOPE (AC-31, deferred pending operator ruling on the
--   enhancer-revise loop): the verdict-vocabulary rework — request_for_change
--   / proposal_rejected release reasons, gate_decision_log CHECK rewrite,
--   hold→request_for_change history migration, fn_lease_clear_maturity CASE
--   extension. This migration does NOT touch gate_decision_log or the P704
--   trigger CASE. P253 already shipped the review-round / stale views — this
--   migration does NOT recreate them.
--
-- This migration is idempotent where practical (IF EXISTS / IF NOT EXISTS /
-- CREATE OR REPLACE). The runner wraps the file in a transaction; per repo
-- convention the file itself carries NO inner BEGIN/COMMIT.
--
-- Rollback: scripts/migrations/283-p1391-lease-ttl-structural-rollback.sql

-- ---------------------------------------------------------------------------
-- AC-24 (structural slice) — PREFLIGHT: refuse to silently no-op.
-- Assert the live constraint we are about to drop actually exists. (The
-- gate_decision_log hash-chain assertion belongs to the deferred AC-31
-- verdict slice and is intentionally NOT performed here — this migration
-- never writes gate_decision_log.)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_one_active'
  ) THEN
    RAISE EXCEPTION
      '[P1391] Preflight failed: expected constraint proposal_lease_one_active '
      'not present on roadmap_proposal.proposal_lease. Refusing to no-op a '
      'missing uniqueness lock — schema is not in the expected pre-P1391 state.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- AC-22 — lease_is_live(released_at, expires_at): VOLATILE, scalar args.
-- VOLATILE (not STABLE) because NOW() is non-deterministic across statement
-- boundaries; the planner must not cache it. Scalar signature so callers and
-- index-friendly predicates can inline `expires_at > now()`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.lease_is_live(
  p_released_at timestamptz,
  p_expires_at  timestamptz
) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT p_released_at IS NULL AND p_expires_at > now()
$$;

COMMENT ON FUNCTION roadmap_proposal.lease_is_live(timestamptz, timestamptz) IS
  'P1391 AC-22: canonical lease-liveness predicate. A lease is alive iff '
  'released_at IS NULL AND expires_at > now(). VOLATILE: now() is '
  'non-deterministic. Use this (or an inlined equivalent that also checks '
  'expires_at > now()) everywhere a proposal_lease is tested for liveness.';

-- ---------------------------------------------------------------------------
-- AC-13 / AC-21 — BACKFILL expired-unreleased leases, preserving phase maturity.
-- Under the TTL model these rows are stale and must be closed so the new
-- partial EXCLUDE applies cleanly. The P704 trigger maps 'lease_expired' to
-- maturity='new', which would silently downgrade a phase-marker 'active'
-- proposal. AC-21 requires the affected proposals retain their pre-migration
-- maturity, so we disable the user trigger for THIS statement only via
-- session_replication_role='replica' (restored immediately after).
-- ---------------------------------------------------------------------------
SET LOCAL session_replication_role = 'replica';

UPDATE roadmap_proposal.proposal_lease
   SET released_at    = expires_at,
       release_reason = 'lease_expired'   -- final/legacy use of the deprecated reason
 WHERE released_at IS NULL
   AND expires_at <= now();

SET LOCAL session_replication_role = 'origin';

-- Post-backfill assertion: zero expired-unreleased rows remain.
DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM roadmap_proposal.proposal_lease
   WHERE released_at IS NULL AND expires_at <= now();
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      '[P1391] Backfill assertion failed: % expired-unreleased leases remain '
      'after backfill. The partial EXCLUDE cannot be installed safely.',
      v_remaining;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- AC-12 — expires_at NULL handling. The live column is ALREADY
-- `NOT NULL DEFAULT now() + '00:30:00'`. This block is defensive/idempotent:
-- it backfills any NULLs (0 expected today) and re-asserts the default+NOT NULL
-- so the migration is self-contained regardless of the starting state.
-- ---------------------------------------------------------------------------
UPDATE roadmap_proposal.proposal_lease
   SET expires_at = claimed_at + INTERVAL '30 minutes'
 WHERE expires_at IS NULL;

ALTER TABLE roadmap_proposal.proposal_lease
  ALTER COLUMN expires_at SET DEFAULT now() + INTERVAL '30 minutes';

ALTER TABLE roadmap_proposal.proposal_lease
  ALTER COLUMN expires_at SET NOT NULL;

-- ---------------------------------------------------------------------------
-- AC-25 — Max-TTL CHECK. With the reaper retired, defend against accidental
-- multi-day/year leases. 24h matches the longest legitimate agent task.
-- Added NOT VALID so the ALTER cannot fail on any historical row, then
-- VALIDATEd (preflight proved 0 live rows exceed 24h; historical released
-- rows are still checked by VALIDATE — if any historical row exceeds 24h the
-- VALIDATE will surface it loudly rather than silently skipping).
-- NB: guard ADD with a NOT-EXISTS check for idempotency.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_max_ttl_check'
  ) THEN
    ALTER TABLE roadmap_proposal.proposal_lease
      ADD CONSTRAINT proposal_lease_max_ttl_check
      CHECK (expires_at <= claimed_at + INTERVAL '24 hours') NOT VALID;
  END IF;
END $$;

ALTER TABLE roadmap_proposal.proposal_lease
  VALIDATE CONSTRAINT proposal_lease_max_ttl_check;

-- ---------------------------------------------------------------------------
-- AC-20 — Drop the misleading `is_active` generated column.
-- `is_active GENERATED ALWAYS AS (released_at IS NULL) STORED` reports TRUE
-- for expired-unreleased leases under TTL semantics. Two views read it
-- (roadmap.proposal_lease passthrough, roadmap_proposal.claim_log); both are
-- redefined to compute liveness via lease_is_live() before the column drop.
-- ---------------------------------------------------------------------------

-- roadmap.proposal_lease — passthrough view: replace is_active with a computed
-- liveness column of the same name so downstream readers keep working.
CREATE OR REPLACE VIEW roadmap.proposal_lease AS
  SELECT id,
         proposal_id,
         agent_identity,
         claimed_at,
         expires_at,
         released_at,
         release_reason,
         roadmap_proposal.lease_is_live(released_at, expires_at) AS is_active
    FROM roadmap_proposal.proposal_lease;

-- roadmap_proposal.claim_log — recompute is_active via lease_is_live().
CREATE OR REPLACE VIEW roadmap_proposal.claim_log AS
  SELECT l.id AS claim_id,
         l.proposal_id,
         p.display_id,
         l.agent_identity,
         l.claimed_at,
         l.expires_at,
         l.released_at,
         l.release_reason,
         roadmap_proposal.lease_is_live(l.released_at, l.expires_at) AS is_active,
         CASE
           WHEN l.released_at IS NOT NULL THEN 'released'::text
           WHEN l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'expired'::text
           ELSE 'active'::text
         END AS claim_status
    FROM roadmap_proposal.proposal_lease l
    JOIN roadmap_proposal.proposal p ON p.id = l.proposal_id;

-- Now the generated column has no dependents; drop it.
ALTER TABLE roadmap_proposal.proposal_lease
  DROP COLUMN IF EXISTS is_active;

-- ---------------------------------------------------------------------------
-- AC-11 + AC-2 — Replace the uniqueness lock with the TTL-aware EXCLUDE.
-- The old `proposal_lease_one_active` UNIQUE(proposal_id, released_at)
-- NULLS NOT DISTINCT blocks two *unreleased* leases but is blind to TTL: an
-- expired-unreleased lease still blocks a new claim. The partial EXCLUDE
-- forbids two leases whose [claimed_at, expires_at) ranges OVERLAP while both
-- are unreleased — so a new claim succeeds the instant the prior lease's range
-- ends (AC-9), with no reaper.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE roadmap_proposal.proposal_lease
  DROP CONSTRAINT IF EXISTS proposal_lease_one_active;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_no_overlap_live'
  ) THEN
    ALTER TABLE roadmap_proposal.proposal_lease
      ADD CONSTRAINT proposal_lease_no_overlap_live
      EXCLUDE USING gist (
        proposal_id WITH =,
        tstzrange(claimed_at, expires_at, '[)') WITH &&
      ) WHERE (released_at IS NULL);
  END IF;
END $$;

-- Post-migration verification (logged via NOTICE; non-fatal):
--   the old lock is gone and the new EXCLUDE is present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'roadmap_proposal.proposal_lease'::regclass
      AND conname  = 'proposal_lease_one_active'
  ) THEN
    RAISE EXCEPTION '[P1391] proposal_lease_one_active still present after drop.';
  END IF;
  RAISE NOTICE '[P1391] structural lease layer installed: EXCLUDE no-overlap-live active, is_active column dropped, max-TTL CHECK validated.';
END $$;
