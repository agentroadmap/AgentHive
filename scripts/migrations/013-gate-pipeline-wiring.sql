-- 013-gate-pipeline-wiring.sql
-- Wires the gate-ready event (from migration 012) into the existing
-- transition_queue / PipelineCron infrastructure.
--
-- Design:
--   PUSH: fn_notify_gate_ready (migration 012) already fires pg_notify.
--         This migration also INSERTs into transition_queue so PipelineCron
--         wakes up immediately and has a durable record to retry.
--
--   PULL: PipelineCron polls transition_queue every 30s. Any mature proposal
--         missed by the push (race, crash, pre-migration backlog) is caught
--         by the pull. v_mature_queue (migration 012) is the source of truth.
--
--   DEAD AGENT: PipelineCron resets 'processing' → 'pending' via exponential
--               backoff and max_attempts=5 for gate reviews. No separate handler
--               needed — existing retry logic covers it.
--
-- Gate routing:
--   D1  DRAFT   → REVIEW   — researcher/PM review: is the proposal well-formed?
--   D2  REVIEW  → DEVELOP  — lead decision: approve design for development?
--   D3  DEVELOP → MERGE    — reviewer: implementation review + AC spot-check
--   D4  MERGE   → COMPLETE — lead + AC full verification: ship it?
-- ============================================================

BEGIN;

-- ─── 1. Unique gate-review constraint on transition_queue ─────────────────────
-- Prevents duplicate gate reviews for the same proposal+gate pair.
-- from_stage encodes the gate (DRAFT=D1, REVIEW=D2, DEVELOP=D3, MERGE=D4).
-- Re-activation: if a prior review was done/failed and the proposal iterates
-- back into the same state and declares mature again, the row is reset.

ALTER TABLE roadmap.transition_queue
  ADD COLUMN IF NOT EXISTS gate TEXT;  -- D1 / D2 / D3 / D4 (null for non-gate rows)

CREATE UNIQUE INDEX IF NOT EXISTS idx_transition_queue_gate_dedup
  ON roadmap.transition_queue (proposal_id, from_stage)
  WHERE gate IS NOT NULL AND status IN ('pending','processing');

-- ─── 2. Gate task templates ───────────────────────────────────────────────────
-- Stored in a small lookup so tasks can be updated without re-deploying.

CREATE TABLE IF NOT EXISTS roadmap.gate_task_templates (
  gate        TEXT PRIMARY KEY CHECK (gate IN ('D1','D2','D3','D4')),
  reviewer_role TEXT NOT NULL,     -- role tag used to select reviewer worktree
  task_template TEXT NOT NULL      -- {{display_id}}, {{title}}, {{status}} are substituted
);

INSERT INTO roadmap.gate_task_templates (gate, reviewer_role, task_template) VALUES
(
  'D1',
  'reviewer',
  E'GATE D1 REVIEW — {{display_id}}: {{title}}\n\n'
  'The author has self-declared this proposal mature and ready for the DRAFT → REVIEW gate.\n\n'
  'Your job:\n'
  '1. Fetch the full proposal: prop_get {{display_id}}\n'
  '2. Assess: Is the summary, motivation, and design complete enough to enter active review?\n'
  '   Are there obvious gaps, missing sections, or unsupported claims?\n'
  '3. Check dependencies: Are all blockers resolved or explicitly deferred?\n'
  '4. Decision:\n'
  '   - ADVANCE: prop_transition id={{display_id}} status=REVIEW reason=decision\n'
  '     notes="<what you verified and why it''s ready>"\n'
  '   - REVISE:  add_discussion proposal_id={{display_id}} context_prefix=decision:\n'
  '     body="D1 gate: revise required — <specific gaps>"\n'
  '     Then: prop_set_maturity id={{display_id}} maturity=active agent=<your-id>\n'
  '5. All decisions MUST use context_prefix=decision: for auditability.'
),
(
  'D2',
  'lead',
  E'GATE D2 DECISION — {{display_id}}: {{title}}\n\n'
  'The proposal is in REVIEW and mature. This is the design-approval gate (REVIEW → DEVELOP).\n\n'
  'Your job:\n'
  '1. Fetch: prop_get {{display_id}} and list_ac {{display_id}}\n'
  '2. Assess: Is the design complete, are acceptance criteria defined and testable?\n'
  '   Are drawbacks and alternatives addressed? Is the dependency chain clean?\n'
  '3. Check all blocking reviews: list_reviews {{display_id}}\n'
  '4. Decision:\n'
  '   - APPROVE: prop_transition id={{display_id}} status=DEVELOP reason=decision\n'
  '     notes="<design approval rationale>"\n'
  '   - REQUEST CHANGES: add_discussion proposal_id={{display_id}} context_prefix=decision:\n'
  '     body="D2 gate: changes required — <specifics>"\n'
  '     prop_transition id={{display_id}} status=DRAFT reason=iteration\n'
  '   - REJECT: prop_transition id={{display_id}} status=REJECTED reason=decision\n'
  '     notes="<rejection rationale>" (requires strong justification)\n'
  '5. Decision note is mandatory — gate will not advance without it.'
),
(
  'D3',
  'reviewer',
  E'GATE D3 REVIEW — {{display_id}}: {{title}}\n\n'
  'The developer has self-declared implementation mature (DEVELOP → MERGE gate).\n\n'
  'Your job:\n'
  '1. Fetch: prop_get {{display_id}}, list_ac {{display_id}}\n'
  '2. Verify ACs: Are acceptance criteria passing or have clear verification paths?\n'
  '   Run test_discover and test_run if applicable.\n'
  '3. Code review: Check implementation files referenced in the design section.\n'
  '4. Decision:\n'
  '   - ADVANCE: prop_transition id={{display_id}} status=MERGE reason=decision\n'
  '     notes="<what was verified: ACs, code quality, test results>"\n'
  '   - REVISE: add_discussion proposal_id={{display_id}} context_prefix=decision:\n'
  '     body="D3 gate: rework required — <specifics>"\n'
  '     prop_set_maturity id={{display_id}} maturity=active\n'
  '5. Must verify at least the critical ACs before advancing.'
),
(
  'D4',
  'lead',
  E'GATE D4 FINAL — {{display_id}}: {{title}}\n\n'
  'This is the MERGE → COMPLETE gate. All ACs must pass before shipping.\n\n'
  'Your job:\n'
  '1. Fetch: prop_get {{display_id}}, list_ac {{display_id}}\n'
  '2. Verify ALL acceptance criteria — this gate requires_ac=all.\n'
  '   Use verify_ac to mark each criterion pass/fail with evidence.\n'
  '3. Check: No blocking reviews outstanding (list_reviews {{display_id}}).\n'
  '4. Check: All dependencies resolved (get_dependencies {{display_id}}).\n'
  '5. Decision:\n'
  '   - SHIP: prop_transition id={{display_id}} status=COMPLETE reason=decision\n'
  '     notes="<AC verification summary, all N criteria verified>"\n'
  '   - HOLD: add_discussion proposal_id={{display_id}} context_prefix=decision:\n'
  '     body="D4 gate: hold — <failing criteria or unresolved deps>"\n'
  '     prop_set_maturity id={{display_id}} maturity=active\n'
  '6. COMPLETE transition is irreversible — verify thoroughly.'
)
ON CONFLICT (gate) DO UPDATE
  SET reviewer_role = EXCLUDED.reviewer_role,
      task_template = EXCLUDED.task_template;

-- ─── 3. Replace fn_notify_gate_ready — push into transition_queue too ─────────
-- The function now:
--   a) Fires pg_notify('proposal_gate_ready') for external listeners (unchanged)
--   b) Fires pg_notify('transition_queued') to wake PipelineCron immediately
--   c) INSERTs into roadmap.transition_queue for durable retry

CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_gate        TEXT;
  v_to_stage    TEXT;
  v_role        TEXT;
  v_task        TEXT;
  v_tpl         TEXT;
BEGIN
  IF NEW.maturity_state <> 'mature'
     OR (OLD.maturity_state IS NOT DISTINCT FROM 'mature')
     OR NEW.status IN ('COMPLETE','REJECTED','DISCARDED','REPLACED')
  THEN
    RETURN NEW;
  END IF;

  -- Determine gate label and target stage
  v_gate := CASE NEW.status
    WHEN 'DRAFT'   THEN 'D1'
    WHEN 'REVIEW'  THEN 'D2'
    WHEN 'DEVELOP' THEN 'D3'
    WHEN 'MERGE'   THEN 'D4'
    ELSE NULL
  END;

  IF v_gate IS NULL THEN
    RETURN NEW;
  END IF;

  v_to_stage := CASE v_gate
    WHEN 'D1' THEN 'REVIEW'
    WHEN 'D2' THEN 'DEVELOP'
    WHEN 'D3' THEN 'MERGE'
    WHEN 'D4' THEN 'COMPLETE'
  END;

  -- Build task from template (replace placeholders)
  SELECT task_template INTO v_tpl
    FROM roadmap.gate_task_templates WHERE gate = v_gate;

  v_task := replace(replace(replace(v_tpl,
    '{{display_id}}', COALESCE(NEW.display_id, NEW.id::text)),
    '{{title}}',      COALESCE(NEW.title, '(no title)')),
    '{{status}}',     NEW.status);

  -- Insert into transition_queue (durable, retryable)
  -- ON CONFLICT: if a prior completed/failed review exists for this gate,
  -- reset it so the re-declared mature proposal gets reviewed again.
  INSERT INTO roadmap.transition_queue (
    proposal_id, from_stage, to_stage,
    triggered_by, max_attempts, gate, metadata
  )
  VALUES (
    NEW.id,
    NEW.status,
    v_to_stage,
    COALESCE(current_setting('app.agent_identity', true), 'system'),
    5,      -- more attempts than default (gate reviews are important)
    v_gate,
    jsonb_build_object(
      'gate',       v_gate,
      'display_id', NEW.display_id,
      'title',      NEW.title,
      'spawn', jsonb_build_object(
        'task',   v_task,
        'worktree', 'claude/one'  -- fallback; routing logic can override
      )
    )
  )
  ON CONFLICT (proposal_id, from_stage)
    WHERE gate IS NOT NULL AND status IN ('pending','processing')
  DO NOTHING;  -- already in queue; PipelineCron will process it

  -- Wake PipelineCron immediately (it listens on 'transition_queued')
  PERFORM pg_notify('transition_queued', json_build_object(
    'display_id', NEW.display_id,
    'gate',       v_gate,
    'from_stage', NEW.status
  )::text);

  -- Also fire the original channel for any external listeners
  PERFORM pg_notify('proposal_gate_ready', json_build_object(
    'display_id', NEW.display_id,
    'id',         NEW.id,
    'title',      NEW.title,
    'status',     NEW.status,
    'gate',       v_gate
  )::text);

  RETURN NEW;
END;
$$;

-- Re-create trigger (same definition, new function body)
DROP TRIGGER IF EXISTS trg_gate_ready ON roadmap.proposal;
CREATE TRIGGER trg_gate_ready
  AFTER UPDATE OF maturity_state ON roadmap.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_gate_ready();

-- ─── 4. Scan-and-enqueue function (pull fallback) ─────────────────────────────
-- Called by PipelineCron on every poll cycle (or manually) to catch:
--   - Proposals mature before this migration ran
--   - Proposals whose transition_queue row was deleted/expired
--
-- Returns count of newly enqueued proposals.

CREATE OR REPLACE FUNCTION roadmap.fn_enqueue_mature_proposals()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count integer := 0;
  v_task  text;
  v_tpl   text;
  v_row   record;
BEGIN
  FOR v_row IN
    SELECT
      p.id,
      p.display_id,
      p.title,
      p.status,
      q.readiness,
      q.recommended_next_state,
      CASE p.status
        WHEN 'DRAFT'   THEN 'D1'
        WHEN 'REVIEW'  THEN 'D2'
        WHEN 'DEVELOP' THEN 'D3'
        WHEN 'MERGE'   THEN 'D4'
      END AS gate
    FROM roadmap.v_mature_queue q
    JOIN roadmap.proposal p ON p.display_id = q.display_id
    WHERE q.readiness IN ('ready','no_ac_defined')  -- ac_incomplete stays in queue
      -- Not already pending/processing
      AND NOT EXISTS (
        SELECT 1 FROM roadmap.transition_queue tq
        WHERE tq.proposal_id = p.id
          AND tq.from_stage  = p.status
          AND tq.gate IS NOT NULL
          AND tq.status IN ('pending','processing')
      )
  LOOP
    SELECT task_template INTO v_tpl
      FROM roadmap.gate_task_templates WHERE gate = v_row.gate;

    IF v_tpl IS NULL THEN CONTINUE; END IF;

    v_task := replace(replace(replace(v_tpl,
      '{{display_id}}', COALESCE(v_row.display_id, v_row.id::text)),
      '{{title}}',      COALESCE(v_row.title, '(no title)')),
      '{{status}}',     v_row.status);

    INSERT INTO roadmap.transition_queue (
      proposal_id, from_stage, to_stage,
      triggered_by, max_attempts, gate, metadata
    ) VALUES (
      v_row.id,
      v_row.status,
      v_row.recommended_next_state,
      'fn_enqueue_mature_proposals',
      5,
      v_row.gate,
      jsonb_build_object(
        'gate',       v_row.gate,
        'display_id', v_row.display_id,
        'title',      v_row.title,
        'spawn', jsonb_build_object(
          'task',     v_task,
          'worktree', 'claude/one'
        )
      )
    )
    ON CONFLICT DO NOTHING;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ─── 5. Backfill: enqueue any currently-mature proposals ──────────────────────

SELECT roadmap.fn_enqueue_mature_proposals();

-- ─── 6. Grant permissions ─────────────────────────────────────────────────────

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles
    WHERE rolname LIKE 'agent_%' OR rolname LIKE 'worktree_%'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON roadmap.gate_task_templates TO %I', r.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION roadmap.fn_enqueue_mature_proposals() TO %I', r.rolname);
  END LOOP;
END $$;

COMMIT;
