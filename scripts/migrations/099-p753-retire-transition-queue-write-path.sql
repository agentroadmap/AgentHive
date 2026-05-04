-- Migration 099: P753 — retire transition_queue write path
--
-- fn_enqueue_mature_proposals() was the only remaining function that INSERT-ed
-- new rows into roadmap.transition_queue. The unified scanQueues() loop in
-- src/core/orchestration/orchestrator.ts (Phase 1) replaces this mechanism:
-- it queries v_mature_queue directly with FOR UPDATE SKIP LOCKED and respects
-- proposal_lease, making the transition_queue population redundant.
--
-- Strategy:
--   - Replace fn_enqueue_mature_proposals() with a no-op stub (returns 0).
--     Existing pending/processing rows drain naturally as PipelineCron handles them.
--   - Keep the transition_queue TABLE intact so the drain path still works
--     until gate-pipeline is decommissioned (migration 100+, Phase 3/A7).
--   - fn_notify_gate_ready() already fires only pg_notify (changed in migration 070);
--     it no longer writes to transition_queue, so no change needed there.
--
-- Rollback: restore fn_enqueue_mature_proposals() from migration 030 body.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_enqueue_mature_proposals()
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    -- P753: retired. Proposal dispatch is now handled by the unified
    -- scanQueues() loop in src/core/orchestration/orchestrator.ts which
    -- queries v_mature_queue directly and respects proposal_lease.
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_enqueue_mature_proposals() IS
    'P753: no-op stub. Superseded by orchestrator scanQueues() loop (Phase 1). Safe to drop after gate-pipeline service is decommissioned (A7).';

COMMIT;
