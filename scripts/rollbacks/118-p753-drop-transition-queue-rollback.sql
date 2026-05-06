-- ROLLBACK for migration 118 (P753 A6 — drop transition_queue)
--
-- Reconstructs roadmap.transition_queue with the canonical shape used by
-- pre-A6 code paths: the original P224 columns (database/migrations/041)
-- plus the columns added by later migrations (gate, attempt_count,
-- max_attempts, process_after, processing_at, completed_at, last_error,
-- metadata) that the deployed PipelineCron expects, plus the P239 completion
-- guard trigger.
--
-- Apply order if rolling back:
--   1. Stop the orchestrator service (so scanQueues() does not race the rebuild).
--   2. psql -f scripts/rollbacks/118-p753-drop-transition-queue-rollback.sql.
--   3. git revert the A6 code commits to restore PipelineCron drain loop +
--      transition_queue READ paths.
--   4. Restart agenthive-orchestrator + agenthive-gate-pipeline services.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.transition_queue (
    id BIGSERIAL PRIMARY KEY,
    proposal_id BIGINT NOT NULL REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
    from_stage TEXT NOT NULL,
    to_stage TEXT NOT NULL,
    triggered_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','done','failed','cancelled','waiting_input','held')),
    gate TEXT CHECK (gate IS NULL OR gate IN ('D1','D2','D3','D4')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    process_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    processing_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AC-5 partial unique index — prevent duplicate pending entries (P224)
CREATE UNIQUE INDEX IF NOT EXISTS idx_transition_queue_pending_unique
    ON roadmap.transition_queue(proposal_id, from_stage, to_stage)
    WHERE status = 'pending';

-- Lookup index used by PipelineCron and a2a-dispatcher
CREATE INDEX IF NOT EXISTS idx_transition_queue_proposal_status
    ON roadmap.transition_queue(proposal_id, status);

-- Stale-processing index used by reap-stale-rows.ts
CREATE INDEX IF NOT EXISTS idx_transition_queue_stale_processing
    ON roadmap.transition_queue(processing_at)
    WHERE status = 'processing' AND processing_at IS NOT NULL;

-- Conflict index used by fn_enqueue_mature_proposals (mig 030)
CREATE UNIQUE INDEX IF NOT EXISTS idx_transition_queue_proposal_gate_active
    ON roadmap.transition_queue(proposal_id, gate)
    WHERE gate IS NOT NULL AND status IN ('pending','processing');

COMMENT ON TABLE roadmap.transition_queue IS
    'P224 lease-gated transition queue (rolled back from P753 drop). Worker bookkeeping for state advances.';

-- P239 completion guard trigger
CREATE OR REPLACE FUNCTION roadmap.fn_guard_transition_queue_done()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_current_status text;
BEGIN
    IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
        SELECT p.status INTO v_current_status
          FROM roadmap_proposal.proposal p
         WHERE p.id = NEW.proposal_id;

        IF v_current_status IS NULL THEN
            RAISE EXCEPTION 'Cannot complete transition_queue %: proposal % not found',
                NEW.id, NEW.proposal_id;
        END IF;

        IF LOWER(v_current_status) <> LOWER(NEW.to_stage) THEN
            RAISE EXCEPTION 'Cannot complete transition_queue %: proposal % is in state %, expected %',
                NEW.id, NEW.proposal_id, v_current_status, NEW.to_stage
                USING HINT = 'Queue completion is worker bookkeeping only; apply the proposal state transition first.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_transition_queue_done ON roadmap.transition_queue;
CREATE TRIGGER trg_guard_transition_queue_done
BEFORE UPDATE OF status ON roadmap.transition_queue
FOR EACH ROW
EXECUTE FUNCTION roadmap.fn_guard_transition_queue_done();

-- Restore the no-op stub for fn_enqueue_mature_proposals (mig 099 shape).
-- Operators rolling back further to pre-mig-099 should also revert mig 099.
CREATE OR REPLACE FUNCTION roadmap.fn_enqueue_mature_proposals()
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN 0;
END;
$$;

COMMIT;
