-- ─────────────────────────────────────────────────────────────────────────────
-- P299-A (companion to M116) — Restore agent_registry.max_concurrent_claims
-- ─────────────────────────────────────────────────────────────────────────────
--
-- After M116 cleared the fn_claim_work_offer overload pollution, OfferProvider
-- claims now resolve to the canonical 5-arg function but immediately fail with:
--
--   ERROR: column ar.max_concurrent_claims does not exist
--   PL/pgSQL function fn_claim_work_offer(text,jsonb,integer,bigint,text)
--   line 21 at SQL statement
--
-- The column was originally added by M067 (P438 fail-closed claim policy) but
-- has gone missing from both roadmap_workforce.agent_registry and
-- roadmap_proposal.agent_registry — likely dropped during a V1/V2 schema
-- reconciliation pass. The function body still references it.
--
-- Fix: re-add the column with the original default. This is idempotent
-- (IF NOT EXISTS) so safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS max_concurrent_claims INT NOT NULL DEFAULT 3;

-- Verification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'roadmap_workforce'
       AND table_name   = 'agent_registry'
       AND column_name  = 'max_concurrent_claims'
  ) THEN
    RAISE EXCEPTION
      '[P299-A/M117] post-migration check failed: max_concurrent_claims still missing';
  END IF;
END $$;

COMMIT;
