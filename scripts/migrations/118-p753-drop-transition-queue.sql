-- env: prod
-- Migration 118: P753 (A6) — drop legacy roadmap.transition_queue
--
-- Background:
--   Migration 099 (already applied) stubbed fn_enqueue_mature_proposals to a
--   no-op so no new rows enter the table. The unified scanQueues() loop
--   (P749/P750/P751/P753 Phase 0+1+2) has owned dispatch since then. With the
--   TS code paths that read/write transition_queue removed in this same change,
--   nothing references the table anymore.
--
-- Pre-flight guard:
--   Aborts with EXCEPTION if any rows remain in pending/processing/waiting_input
--   state. Operator must drain those rows before re-running this migration.
--
-- Effect:
--   DROP TABLE roadmap.transition_queue CASCADE — also drops:
--     - trigger trg_guard_transition_queue_done (P239)
--     - function fn_guard_transition_queue_done (P239)
--     - function fn_enqueue_mature_proposals (no-op stub from mig 099)
--     - any partial unique indexes / FKs pointing at the table
--
-- Rollback: scripts/rollbacks/118-p753-drop-transition-queue-rollback.sql
--   recreates the table shape + P239 trigger from the pre-removal baseline.
--   Code commits in this same A6 change must also be reverted to restore the
--   PipelineCron drain loop.

BEGIN;

DO $$
DECLARE
    v_unfinished_count integer;
BEGIN
    SELECT COUNT(*) INTO v_unfinished_count
    FROM roadmap.transition_queue
    WHERE status IN ('pending', 'processing', 'waiting_input', 'held');

    IF v_unfinished_count > 0 THEN
        RAISE EXCEPTION
            'P753 pre-flight FAILED: % unfinished transition_queue row(s) (status in pending/processing/waiting_input/held). Drain or cancel before re-running.',
            v_unfinished_count
            USING HINT = 'Run scripts/agent-stop.ts on legacy refs (already removed in A6 code), or UPDATE roadmap.transition_queue SET status=''cancelled'' WHERE status IN (...) before applying.';
    END IF;
END;
$$;

DROP TABLE IF EXISTS roadmap.transition_queue CASCADE;

-- The CASCADE above drops the P239 trigger + fn_guard_transition_queue_done
-- automatically (the trigger lives on the table). fn_enqueue_mature_proposals
-- and fn_notify_gate_ready are independent functions; drop the stubs explicitly
-- to keep the surface clean.

DROP FUNCTION IF EXISTS roadmap.fn_enqueue_mature_proposals();

COMMIT;
