-- ─────────────────────────────────────────────────────────────────────────────
-- P299-A — HOTFIX: drop duplicate fn_claim_work_offer overloads
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Live state observed via pg_proc on 2026-05-06:
--
--   roadmap_proposal.fn_claim_work_offer(text, jsonb, integer, bigint)
--   roadmap_workforce.fn_claim_work_offer(text, jsonb, integer, bigint)
--   roadmap_workforce.fn_claim_work_offer(text, jsonb, integer, bigint, text)
--
-- The two 4-arg overloads collide with the canonical 5-arg (M072+M115) when
-- the caller passes 4 args and the 5th has a DEFAULT. Postgres refuses to
-- resolve the call:
--
--   ERROR: function roadmap_workforce.fn_claim_work_offer(
--     unknown, jsonb, unknown, unknown) is not unique
--
-- This blocks every OfferProvider claim cycle in agenthive-claude-agency.
--
-- Distinct from P855: P855 (M115) fixed a column-ambiguity bug INSIDE the
-- function body. This migration removes leftover overload signatures that
-- pollute name resolution. The two fixes commute.
--
-- Keep: roadmap_workforce.fn_claim_work_offer(text, jsonb, integer, bigint, text)
-- Drop: the 4-arg signatures in roadmap_proposal and roadmap_workforce
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP FUNCTION IF EXISTS roadmap_workforce.fn_claim_work_offer(
  TEXT, JSONB, INTEGER, BIGINT
);

DROP FUNCTION IF EXISTS roadmap_proposal.fn_claim_work_offer(
  TEXT, JSONB, INTEGER, BIGINT
);

-- Verification (assertion-style; raises if state is wrong post-drop)
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*)
    INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'fn_claim_work_offer';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      '[P299-A] post-migration check failed: expected 1 fn_claim_work_offer overload, found %',
      v_count;
  END IF;
END $$;

COMMIT;
