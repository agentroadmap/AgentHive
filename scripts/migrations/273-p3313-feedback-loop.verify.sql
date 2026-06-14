-- 268-p3313-feedback-loop.verify.sql
-- P3313 AC-2 / AC-3 integration verification. Runs entirely inside a single
-- transaction that ROLLBACKs at the end — NO live-DB pollution. Assumes
-- migration 268 has been applied (functions/tables exist).
--
-- Run:
--   PGPASSWORD=... psql -h 127.0.0.1 -p 5432 -U admin -d agenthive \
--     -v ON_ERROR_STOP=1 -f scripts/migrations/268-p3313-feedback-loop.verify.sql

BEGIN;

-- ── AC-2: closed loop — a recorded failure lowers the (model,task_class) score ──
-- 1. Baseline read on a fresh synthetic cell (cold-start prior = 0.5).
SELECT 'baseline' AS step, score AS baseline_score
FROM roadmap_workforce.fn_get_reliability('model', 'p3313-verify-model', 'develop');

-- 2. Record a hard_failure.
SELECT 'after_fail_1' AS step, score
FROM roadmap_workforce.fn_record_run_outcome('model', 'p3313-verify-model', 'develop', 'hard_failure', 1.0);

-- 3. Record another hard_failure — score must keep dropping (monotonic on failure).
SELECT 'after_fail_2' AS step, score
FROM roadmap_workforce.fn_record_run_outcome('model', 'p3313-verify-model', 'develop', 'hard_failure', 2.0);

-- 4. A success bumps it back up (closed loop is bidirectional).
SELECT 'after_success' AS step, score
FROM roadmap_workforce.fn_record_run_outcome('model', 'p3313-verify-model', 'develop', 'success', 1.0);

-- 5. ASSERT: next read via P3311 fn_get_reliability reflects the writes (not the prior).
DO $$
DECLARE v_score numeric; v_samples int;
BEGIN
  SELECT score, sample_count INTO v_score, v_samples
  FROM roadmap_workforce.fn_get_reliability('model', 'p3313-verify-model', 'develop');
  IF v_samples = 0 THEN
    RAISE EXCEPTION 'AC-2 FAIL: closed loop did not persist (sample_count=0, still cold-start prior)';
  END IF;
  -- after 2 fails (w=3 total beta) + 1 success (alpha+1): score must be < 0.5 cold-start
  IF v_score >= 0.5 THEN
    RAISE EXCEPTION 'AC-2 FAIL: net failures did not lower score below prior (score=%)', v_score;
  END IF;
  RAISE NOTICE 'AC-2 PASS: closed loop persisted, score=% after failures', v_score;
END $$;

-- ── AC-3: hard floor BLOCKS a below-floor candidate and is never silent ──
DO $$
DECLARE v_allowed boolean; v_alerts int;
BEGIN
  v_allowed := roadmap_workforce.fn_check_reliability_floor('gate_review','model','p3313-verify-model',0.40);
  IF v_allowed THEN
    RAISE EXCEPTION 'AC-3 FAIL: gate_review @0.40 should be BLOCKED (hard floor 0.85)';
  END IF;
  SELECT count(*) INTO v_alerts FROM roadmap_workforce.reliability_floor_alert
   WHERE scope_key = 'p3313-verify-model' AND task_class = 'gate_review' AND blocked = true;
  IF v_alerts = 0 THEN
    RAISE EXCEPTION 'AC-3 FAIL: block was SILENT (no reliability_floor_alert row)';
  END IF;
  RAISE NOTICE 'AC-3 PASS: hard floor blocked + alerted (alerts=%)', v_alerts;
END $$;

-- ── AC-3: above-floor candidate is allowed, no new alert ──
DO $$
DECLARE v_allowed boolean;
BEGIN
  v_allowed := roadmap_workforce.fn_check_reliability_floor('gate_review','model','p3313-verify-model',0.90);
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'AC-3 FAIL: gate_review @0.90 should be ALLOWED (>= floor 0.85)';
  END IF;
  RAISE NOTICE 'AC-3 PASS: above-floor candidate allowed';
END $$;

ROLLBACK;
