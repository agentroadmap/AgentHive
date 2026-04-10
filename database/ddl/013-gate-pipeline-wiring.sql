-- =============================================================================
-- 013-gate-pipeline-wiring.sql
-- Description: Wire the gate pipeline — maturity → queue → spawn → transition
-- Date: 2026-04-09
-- Requires: 012-maturity-redesign.sql
--
-- Flow after this migration:
--   Agent calls prop_set_maturity id=P048 maturity=mature
--     → DB trigger trg_gate_ready fires pg_notify('proposal_gate_ready')
--     → fn_notify_gate_ready() INSERTs into transition_queue (gate=D1)
--     → pg_notify('transition_queued') wakes PipelineCron
--     → PipelineCron spawns reviewer agent with D1 task
--     → Reviewer calls prop_transition status=REVIEW notes="..."
--     → Gate guard enforces notes non-empty for decision transitions
--
-- This migration:
--   1. Adds gate column to transition_queue + unique index for dedup
--   2. Creates gate_task_templates table with D1–D4 task prompts
--   3. Updates fn_notify_gate_ready to INSERT into transition_queue + notify
--   4. Creates fn_enqueue_mature_proposals() — pull-scan for poll cycles
--   5. Backfills currently-mature proposals into the queue
-- =============================================================================

BEGIN;

SET search_path TO roadmap, public;


-- ─── 1. Add gate column to transition_queue ──────────────────────────────────

ALTER TABLE roadmap.transition_queue
    ADD COLUMN IF NOT EXISTS gate text NULL;

ALTER TABLE roadmap.transition_queue
    ADD CONSTRAINT transition_queue_gate_check
    CHECK (gate IS NULL OR gate IN ('D1', 'D2', 'D3', 'D4'));

COMMENT ON COLUMN roadmap.transition_queue.gate IS
    'Gate number (D1–D4) for gate-initiated transitions. '
    'NULL for manual/agent-initiated transitions. '
    'Used with proposal_id for dedup: one pending gate entry per proposal.';

-- Unique index: at most one pending gate entry per proposal+gate combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_transition_queue_gate_dedup
    ON roadmap.transition_queue (proposal_id, gate)
    WHERE gate IS NOT NULL AND status IN ('pending', 'processing');


-- ─── 2. Create gate_task_templates table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.gate_task_templates (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    gate_number     int         NOT NULL CHECK (gate_number BETWEEN 1 AND 4),
    from_state      text        NOT NULL,
    to_state        text        NOT NULL,
    task_prompt     text        NOT NULL,
    description     text        NULL,
    is_active       bool        DEFAULT true NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT gate_task_templates_pkey          PRIMARY KEY (id),
    CONSTRAINT gate_task_templates_gate_key      UNIQUE (gate_number)
);

COMMENT ON TABLE roadmap.gate_task_templates IS
    'Task prompts for each gate (D1–D4). Spawned agents receive these as their task.';

-- D1: Draft → Review (architecture gate)
INSERT INTO roadmap.gate_task_templates (gate_number, from_state, to_state, task_prompt, description)
VALUES (
    1, 'Draft', 'Review',
    E'You are an AgentHive gate reviewer (D1: Architecture Gate).\n\n'
    'Your job is to evaluate whether this proposal is ready to advance from Draft to Review.\n\n'
    'Steps:\n'
    '1. Read the full proposal using prop_get\n'
    '2. Evaluate: Is the proposal coherent? Are the ACs measurable?\n'
    '3. Check dependencies: Are all blocking dependencies resolved?\n'
    '4. Make a decision:\n'
    '   - If ready: call prop_transition id=<id> status=Review author=<your_name> summary="<decision notes>"\n'
    '   - If needs revision: call prop_set_maturity id=<id> maturity=active\n'
    '   - If should be discarded: call prop_set_maturity id=<id> maturity=obsolete\n\n'
    'IMPORTANT: Your prop_transition summary MUST include decision notes explaining your reasoning.'
) ON CONFLICT (gate_number) DO UPDATE SET
    task_prompt = EXCLUDED.task_prompt,
    updated_at = now();

-- D2: Review → Develop (feasibility gate)
INSERT INTO roadmap.gate_task_templates (gate_number, from_state, to_state, task_prompt, description)
VALUES (
    2, 'Review', 'Develop',
    E'You are an AgentHive gate reviewer (D2: Feasibility Gate).\n\n'
    'Evaluate whether this reviewed proposal is ready for development.\n\n'
    'Steps:\n'
    '1. Read the full proposal using prop_get\n'
    '2. Evaluate: Is the design feasible? Are tradeoffs documented?\n'
    '3. Check: Do ACs cover the acceptance criteria?\n'
    '4. Make a decision:\n'
    '   - If ready: call prop_transition id=<id> status=Develop author=<your_name> summary="<decision notes>"\n'
    '   - If needs more review: call prop_set_maturity id=<id> maturity=active\n'
    '   - If rejected: call prop_set_maturity id=<id> maturity=obsolete\n\n'
    'IMPORTANT: Your prop_transition summary MUST include decision notes explaining your reasoning.'
) ON CONFLICT (gate_number) DO UPDATE SET
    task_prompt = EXCLUDED.task_prompt,
    updated_at = now();

-- D3: Develop → Merge (code review gate)
INSERT INTO roadmap.gate_task_templates (gate_number, from_state, to_state, task_prompt, description)
VALUES (
    3, 'Develop', 'Merge',
    E'You are an AgentHive gate reviewer (D3: Code Review Gate).\n\n'
    'Evaluate whether the implementation is ready for merge.\n\n'
    'Steps:\n'
    '1. Read the full proposal using prop_get\n'
    '2. Check: Are all acceptance criteria verified?\n'
    '3. Check: Do tests pass? Is the code complete?\n'
    '4. Make a decision:\n'
    '   - If ready: call prop_transition id=<id> status=Merge author=<your_name> summary="<decision notes>"\n'
    '   - If needs more work: call prop_set_maturity id=<id> maturity=active\n'
    '   - If rejected: call prop_set_maturity id=<id> maturity=obsolete\n\n'
    'IMPORTANT: Your prop_transition summary MUST include decision notes explaining your reasoning.'
) ON CONFLICT (gate_number) DO UPDATE SET
    task_prompt = EXCLUDED.task_prompt,
    updated_at = now();

-- D4: Merge → Complete (final approval gate)
INSERT INTO roadmap.gate_task_templates (gate_number, from_state, to_state, task_prompt, description)
VALUES (
    4, 'Merge', 'Complete',
    E'You are an AgentHive gate reviewer (D4: Final Approval Gate).\n\n'
    'Evaluate whether this merged proposal is ready for completion.\n\n'
    'Steps:\n'
    '1. Read the full proposal using prop_get\n'
    '2. Check: Is the merge clean? Any regressions?\n'
    '3. Check: Are all dependencies satisfied?\n'
    '4. Make a decision:\n'
    '   - If ready: call prop_transition id=<id> status=Complete author=<your_name> summary="<decision notes>"\n'
    '   - If needs rework: call prop_set_maturity id=<id> maturity=active\n'
    '   - If rejected: call prop_set_maturity id=<id> maturity=obsolete\n\n'
    'IMPORTANT: Your prop_transition summary MUST include decision notes explaining your reasoning.'
) ON CONFLICT (gate_number) DO UPDATE SET
    task_prompt = EXCLUDED.task_prompt,
    updated_at = now();


-- ─── 3. Update fn_notify_gate_ready to enqueue + notify ─────────────────────
-- Replaces the version from 012 that only did pg_notify.
-- Now: INSERT into transition_queue (durable) + pg_notify (real-time).

CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_gate          text;
    v_to_state      text;
    v_task_prompt   text;
    v_queue_id      int8;
BEGIN
    -- Only fire when maturity_state actually changes to 'mature'
    IF NEW.maturity_state = 'mature'
       AND OLD.maturity_state IS DISTINCT FROM 'mature' THEN

        -- Determine which gate based on current status
        CASE NEW.status
            WHEN 'Draft'   THEN v_gate := 'D1'; v_to_state := 'Review';
            WHEN 'Review'  THEN v_gate := 'D2'; v_to_state := 'Develop';
            WHEN 'Develop' THEN v_gate := 'D3'; v_to_state := 'Merge';
            WHEN 'Merge'   THEN v_gate := 'D4'; v_to_state := 'Complete';
            ELSE
                -- Unknown state for gating — just notify, don't enqueue
                PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
                    'proposal_id', NEW.id,
                    'display_id',  NEW.display_id,
                    'stage',       NEW.status,
                    'reason',      'no_gate_defined_for_state',
                    'ts',          to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                )::text);
                RETURN NEW;
        END CASE;

        -- Look up the task prompt for this gate
        SELECT gt.task_prompt INTO v_task_prompt
        FROM roadmap.gate_task_templates gt
        WHERE gt.gate_number = REPLACE(v_gate, 'D', '')::int
          AND gt.is_active = true
        LIMIT 1;

        -- Build the spawn metadata
        INSERT INTO roadmap.transition_queue (
            proposal_id, from_stage, to_stage, triggered_by,
            gate, status, metadata
        ) VALUES (
            NEW.id,
            NEW.status,
            v_to_state,
            'gate_pipeline',
            v_gate,
            'pending',
            jsonb_build_object(
                'task', COALESCE(v_task_prompt, 'Process gate ' || v_gate || ' for proposal ' || NEW.display_id),
                'gate', v_gate,
                'proposal_display_id', NEW.display_id,
                'spawn', jsonb_build_object(
                    'worktree', 'claude/one',
                    'timeoutMs', 300000
                )
            )
        )
        ON CONFLICT (proposal_id, gate)
        WHERE gate IS NOT NULL AND transition_queue.status IN ('pending', 'processing')
        DO NOTHING
        RETURNING id INTO v_queue_id;

        -- Only notify if we actually inserted (not a duplicate)
        IF v_queue_id IS NOT NULL THEN
            PERFORM pg_notify('transition_queued', jsonb_build_object(
                'queue_id',     v_queue_id,
                'proposal_id',  NEW.id,
                'display_id',   NEW.display_id,
                'gate',         v_gate,
                'from_stage',   NEW.status,
                'to_stage',     v_to_state,
                'ts',           to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )::text);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Replace the trigger with updated function
DROP TRIGGER IF EXISTS trg_gate_ready ON roadmap.proposal;
CREATE TRIGGER trg_gate_ready
    BEFORE UPDATE OF maturity_state ON roadmap.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_notify_gate_ready();


-- ─── 4. Create fn_enqueue_mature_proposals() — pull-scan ────────────────────
-- Called every poll cycle by PipelineCron or pg_cron.
-- Scans for mature proposals not yet in the queue and enqueues them.

CREATE OR REPLACE FUNCTION roadmap.fn_enqueue_mature_proposals()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    v_count int := 0;
    v_gate  text;
    v_to_state text;
    v_task_prompt text;
BEGIN
    FOR rec IN (
        SELECT p.id, p.display_id, p.status
        FROM roadmap.proposal p
        WHERE p.maturity_state = 'mature'
          AND NOT EXISTS (
              SELECT 1 FROM roadmap.transition_queue tq
              WHERE tq.proposal_id = p.id
                AND tq.gate IS NOT NULL
                AND tq.status IN ('pending', 'processing')
          )
    ) LOOP
        -- Determine gate
        CASE rec.status
            WHEN 'Draft'   THEN v_gate := 'D1'; v_to_state := 'Review';
            WHEN 'Review'  THEN v_gate := 'D2'; v_to_state := 'Develop';
            WHEN 'Develop' THEN v_gate := 'D3'; v_to_state := 'Merge';
            WHEN 'Merge'   THEN v_gate := 'D4'; v_to_state := 'Complete';
            ELSE CONTINUE;
        END CASE;

        -- Look up task prompt
        SELECT gt.task_prompt INTO v_task_prompt
        FROM roadmap.gate_task_templates gt
        WHERE gt.gate_number = REPLACE(v_gate, 'D', '')::int
          AND gt.is_active = true
        LIMIT 1;

        INSERT INTO roadmap.transition_queue (
            proposal_id, from_stage, to_stage, triggered_by,
            gate, status, metadata
        ) VALUES (
            rec.id, rec.status, v_to_state, 'gate_scan',
            v_gate, 'pending',
            jsonb_build_object(
                'task', COALESCE(v_task_prompt, 'Process gate ' || v_gate || ' for proposal ' || rec.display_id),
                'gate', v_gate,
                'proposal_display_id', rec.display_id,
                'spawn', jsonb_build_object(
                    'worktree', 'claude/one',
                    'timeoutMs', 300000
                )
            )
        )
        ON CONFLICT (proposal_id, gate)
        WHERE gate IS NOT NULL AND transition_queue.status IN ('pending', 'processing')
        DO NOTHING;

        v_count := v_count + 1;
    END LOOP;

    -- Notify if we enqueued anything
    IF v_count > 0 THEN
        PERFORM pg_notify('transition_queued', jsonb_build_object(
            'source', 'gate_scan',
            'enqueued', v_count,
            'ts', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_enqueue_mature_proposals IS
    'Pull-scan: enqueues any mature proposals not already in the transition queue. '
    'Returns count of newly enqueued items. Called every poll cycle.';


-- ─── 5. Backfill currently-mature proposals ─────────────────────────────────

SELECT roadmap.fn_enqueue_mature_proposals();


COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- SELECT gate, COUNT(*) FROM roadmap.transition_queue
--   WHERE gate IS NOT NULL AND status = 'pending'
--   GROUP BY gate;
--
-- SELECT * FROM roadmap.gate_task_templates ORDER BY gate_number;
--
-- SELECT display_id, status, maturity_state
-- FROM roadmap.proposal WHERE maturity_state = 'mature';
