-- P1093: One-time stale agent_registry backfill.
--
-- Expected first-run prune was approximately 8,000 rows from the observed
-- 8,501-row stale inactive set. Environments can drift between proposal review
-- and apply time, so this migration raises a warning instead of aborting when
-- the count is outside the expected band.

BEGIN;

DO $$
DECLARE
  v_deleted INT;
  v_expected INT := 8000;
  v_tolerance INT := 1000;
BEGIN
  SELECT roadmap_workforce.fn_reap_stale_registry('30 days'::interval, 1000)
    INTO v_deleted;

  IF v_deleted < v_expected - v_tolerance OR v_deleted > v_expected + v_tolerance THEN
    RAISE WARNING
      'P1093 registry backfill reaped % rows; expected approximately % (+/- %). Review stale registry count and guards.',
      v_deleted, v_expected, v_tolerance;
  ELSE
    RAISE NOTICE
      'P1093 registry backfill reaped % rows; expected approximately % (+/- %).',
      v_deleted, v_expected, v_tolerance;
  END IF;
END $$;

COMMIT;
