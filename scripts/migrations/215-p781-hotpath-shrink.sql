-- P781: Shrink hot-path proposal functions to wake-up notifications and invariant checks.
--
-- Forward: Remove hardcoded stage literals and routing logic from:
--   - fn_notify_gate_ready
--   - fn_sync_proposal_maturity
--   - fn_lease_clear_maturity_on_release
--   - fn_guard_terminal_maturity (new, for AC-P781-08)
--
-- Create helper function is_terminal_stage() to replace hardcoded stage checks.
-- Emit generic orchestrator_wake notifications instead of proposal_gate_ready with routing payloads.

-- Helper function: detect if a stage is terminal (used by maturity sync and gate notify)
-- A stage is terminal if it has no outgoing transitions in its workflow template.
CREATE OR REPLACE FUNCTION roadmap.is_terminal_stage(p_stage text, p_template_id int8)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM roadmap.workflow_transitions
    WHERE template_id = p_template_id
      AND from_stage = p_stage
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
  v_template_id int8;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Look up workflow to check if new status is terminal
  SELECT w.template_id INTO v_template_id
  FROM roadmap.workflows w
  WHERE w.proposal_id = NEW.id
  LIMIT 1;

  IF v_template_id IS NOT NULL THEN
    v_is_terminal := roadmap.is_terminal_stage(NEW.status, v_template_id);
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
  v_template_id int8;
BEGIN
  -- Only check on maturity changes
  IF NEW.maturity IS NOT DISTINCT FROM OLD.maturity THEN
    RETURN NEW;
  END IF;

  -- Look up workflow to check if current status is terminal
  SELECT w.template_id INTO v_template_id
  FROM roadmap.workflows w
  WHERE w.proposal_id = NEW.id
  LIMIT 1;

  IF v_template_id IS NOT NULL THEN
    v_is_terminal := roadmap.is_terminal_stage(NEW.status, v_template_id);
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

-- fn_check_phase_gate: Remove hardcoded DEPLOYED reference (doesn't exist) and COMPLETE check
-- Updated to use workflow-derived terminal stage detection.
CREATE OR REPLACE FUNCTION roadmap.fn_check_phase_gate(p_proposal_id bigint, p_target_status text DEFAULT 'REVIEW'::text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_phase_id       INTEGER;
  v_phase_name     TEXT;
  v_prev_phase_id  INTEGER;
  v_prev_open      BOOLEAN;
  v_prev_name      TEXT;
  v_incomplete_ct  BIGINT;
  v_template_id    int8;
  v_is_terminal    boolean;
BEGIN
  -- Only advisory for DRAFT→REVIEW transitions
  IF p_target_status <> 'REVIEW' THEN
    RETURN TRUE;
  END IF;

  -- Get the proposal's assigned phase (read from base table for accuracy)
  SELECT phase_id INTO v_phase_id
  FROM roadmap_proposal.proposal
  WHERE id = p_proposal_id;

  -- No phase assigned → no gate applies
  IF v_phase_id IS NULL OR v_phase_id = 0 THEN
    RETURN TRUE;
  END IF;

  v_prev_phase_id := v_phase_id - 1;

  -- Check that the predecessor phase is open (i.e. in progress or complete)
  SELECT name, is_open
  INTO v_prev_name, v_prev_open
  FROM roadmap.program_phases
  WHERE id = v_prev_phase_id;

  IF NOT FOUND OR NOT v_prev_open THEN
    RAISE NOTICE
      '[ADVISORY] Phase % (%) is not yet open. '
      'Proposal % cannot advance to REVIEW until its predecessor phase is open. '
      'Override is allowed but must be recorded in proposal audit column.',
      v_prev_phase_id, v_prev_name, p_proposal_id;
    RETURN FALSE;
  END IF;

  -- Check that all Phase N-1 proposals are in terminal states
  SELECT count(*) INTO v_incomplete_ct
  FROM roadmap_proposal.proposal p
  JOIN roadmap.program_phases ph ON p.phase_id = ph.id
  JOIN roadmap.workflows w ON w.proposal_id = p.id
  WHERE ph.id = v_prev_phase_id
    AND NOT roadmap.is_terminal_stage(p.status, w.template_id);

  IF v_incomplete_ct > 0 THEN
    RAISE NOTICE
      '[ADVISORY] Phase % has % incomplete proposal(s). '
      'Proposal % should wait for Phase % to exit before advancing to REVIEW.',
      v_prev_phase_id, v_incomplete_ct, p_proposal_id, v_prev_phase_id;
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_check_phase_gate(bigint, text) IS
  'P781: Check if a proposal can advance to the next phase. Uses workflow_stages for terminal detection instead of hardcoded literals.';

-- Rollback: Restore original versions with hardcoded stage routing
-- (These are saved separately in the :rollback section handled by the migration runner)
