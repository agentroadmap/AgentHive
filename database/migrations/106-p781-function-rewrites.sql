-- P781 (C0): Rewrite DB functions to remove hardcoded stage literals
-- and emit to orchestrator_wake channel instead.
-- Functions: fn_notify_gate_ready, fn_sync_proposal_maturity, fn_lease_clear_maturity_on_release
-- Plus fn_guard_terminal_maturity per AC-P781-08.

-- Helper function: detect if a stage is terminal (used by maturity sync and gate notify)
CREATE OR REPLACE FUNCTION roadmap.is_terminal_stage(p_stage text, p_workflow_id int8)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXISTS(
    SELECT 1 FROM roadmap.workflow_stages
    WHERE workflow_id = p_workflow_id
      AND stage_name = p_stage
      AND is_terminal = true
  )
$$;

-- fn_notify_gate_ready: Fire when maturity becomes 'mature'.
-- Instead of hardcoded CASE on stage names, emit generic wake signal.
-- The orchestrator reads workflows table to determine next stage.
CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.maturity = 'mature'
     AND OLD.maturity IS DISTINCT FROM 'mature' THEN
    -- Emit generic wake signal with minimal payload
    PERFORM pg_notify(
      'orchestrator_wake',
      jsonb_build_object(
        'proposal_id',            NEW.id,
        'display_id',             NEW.display_id,
        'title',                  NEW.title,
        'type',                   NEW.type,
        'old_status',             OLD.status,
        'new_status',             NEW.status,
        'old_maturity',           OLD.maturity,
        'new_maturity',           NEW.maturity,
        'required_capabilities',  NEW.required_capabilities,
        'event_kind',             'maturity_ready',
        'ts',                     to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_notify_gate_ready() IS
  'P781: Fire on maturity=mature transition. Emit generic orchestrator_wake signal. Routing logic moves to unified queue scanner.';

-- fn_sync_proposal_maturity: Reset maturity to ''new'' on state transition.
-- No hardcoded stage checks beyond terminal detection via workflow_stages.
CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_terminal boolean;
  v_workflow_id int8;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Look up workflow to check if new status is terminal
  SELECT w.id INTO v_workflow_id
  FROM roadmap.workflows w
  WHERE w.proposal_id = NEW.id
  LIMIT 1;

  IF v_workflow_id IS NOT NULL THEN
    v_is_terminal := roadmap.is_terminal_stage(NEW.status, v_workflow_id);
  ELSE
    -- Fallback: if no workflow found, assume terminal if status is COMPLETE
    -- (backward compatibility during transition)
    v_is_terminal := (NEW.status = 'COMPLETE');
  END IF;

  -- Non-terminal states: reset maturity to ''new''
  -- Terminal states: preserve maturity (work is done)
  IF NOT v_is_terminal THEN
    NEW.maturity := 'new';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_sync_proposal_maturity() IS
  'P781: Reset maturity=new on state transition to non-terminal stages. Uses workflow_stages for terminal detection, not hardcoded literals.';

-- fn_guard_terminal_maturity: Prevent maturity changes on terminal proposals.
-- Per AC-P781-08, this also needs workflow-driven terminal check.
CREATE OR REPLACE FUNCTION roadmap.fn_guard_terminal_maturity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_terminal boolean;
  v_workflow_id int8;
BEGIN
  -- Only check on maturity changes
  IF NEW.maturity IS NOT DISTINCT FROM OLD.maturity THEN
    RETURN NEW;
  END IF;

  -- Look up workflow to check if current status is terminal
  SELECT w.id INTO v_workflow_id
  FROM roadmap.workflows w
  WHERE w.proposal_id = NEW.id
  LIMIT 1;

  IF v_workflow_id IS NOT NULL THEN
    v_is_terminal := roadmap.is_terminal_stage(NEW.status, v_workflow_id);
  ELSE
    v_is_terminal := (NEW.status = 'COMPLETE');
  END IF;

  -- If we are in a terminal state, prevent non-'mature' maturity
  IF v_is_terminal AND NEW.maturity IS NOT NULL AND NEW.maturity != 'mature' THEN
    NEW.maturity := 'mature';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_guard_terminal_maturity() IS
  'P781: Guard terminal proposals. Uses workflow_stages for terminal detection instead of hardcoded stage literals.';

-- fn_lease_clear_maturity_on_release: Clear maturity on lease release.
-- No hardcoded stage routing, only lease cleanup.
CREATE OR REPLACE FUNCTION roadmap.fn_lease_clear_maturity_on_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- When a lease is released, clear maturity back to 'new' if currently 'active'
  IF NEW.released_at IS NOT NULL
     AND OLD.released_at IS NULL THEN
    UPDATE roadmap_proposal.proposal
    SET maturity = 'new'
    WHERE id = NEW.proposal_id
      AND maturity = 'active';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_lease_clear_maturity_on_release() IS
  'P781: On lease release, clear maturity from ''active'' back to ''new''. No stage routing logic.';

-- AC-P781-09: Exhaustive scan for legacy literals
-- This query should return zero rows post-migration:
-- SELECT proname FROM pg_proc WHERE pronamespace IN
--   (SELECT oid FROM pg_namespace WHERE nspname IN ('roadmap','roadmap_proposal','public'))
--   AND prosrc ~ 'TRIAGE|FIXING|\\bFIX\\b|DEPLOYED|\\bDONE\\b|ESCALATE|WONT_FIX|NON_ISSUE|REJECTED|DISCARDED|REPLACED'
