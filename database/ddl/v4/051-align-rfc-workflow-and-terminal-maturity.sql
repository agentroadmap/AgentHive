-- P410: align active workflow semantics with the current RFC contract
--
-- Intent:
-- 1. issue proposals use Standard RFC, not the legacy Quick Fix workflow
-- 2. entering any new state resets maturity to 'new'
-- 3. COMPLETE/mature is terminal metadata only; it does not enqueue another gate advance

UPDATE roadmap_proposal.proposal_type_config
SET workflow_name = 'Standard RFC',
    description = 'Bug, defect, or problem report against a product, component, or feature'
WHERE type = 'issue'
  AND workflow_name IS DISTINCT FROM 'Standard RFC';

INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES ('hotfix', 'Hotfix', 'Localized operational fix to a running instance')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION roadmap.fn_sync_proposal_maturity() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  NEW.maturity := 'new';
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_sync_proposal_maturity() IS
  'P410: Every workflow state entry resets maturity to new, including MERGE -> COMPLETE. COMPLETE/mature is terminal metadata only and does not queue another advance gate.';

CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_gate        text;
    v_to_state    text;
    v_task_prompt text;
BEGIN
    IF NEW.maturity = 'mature'
       AND OLD.maturity IS DISTINCT FROM 'mature' THEN
        CASE UPPER(NEW.status)
            WHEN 'DRAFT'   THEN v_gate := 'D1'; v_to_state := 'REVIEW';
            WHEN 'REVIEW'  THEN v_gate := 'D2'; v_to_state := 'DEVELOP';
            WHEN 'DEVELOP' THEN v_gate := 'D3'; v_to_state := 'MERGE';
            WHEN 'MERGE'   THEN v_gate := 'D4'; v_to_state := 'COMPLETE';
            ELSE
                RETURN NEW;
        END CASE;

        SELECT gt.task_prompt INTO v_task_prompt
        FROM roadmap.gate_task_templates gt
        WHERE gt.gate_number = REPLACE(v_gate, 'D', '')::int
          AND gt.is_active = true
        LIMIT 1;

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
                'display_id', NEW.display_id,
                'title', NEW.title,
                'workflow_state', NEW.status,
                'maturity', NEW.maturity,
                'task_prompt', v_task_prompt,
                'queued_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        );

        PERFORM pg_notify(
            'proposal_gate_ready',
            jsonb_build_object(
                'proposal_id', NEW.id,
                'display_id',  NEW.display_id,
                'gate',        v_gate,
                'from_stage',  NEW.status,
                'to_stage',    v_to_state,
                'ts',          to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_notify_gate_ready() IS
  'P410: Only RFC advance states (DRAFT, REVIEW, DEVELOP, MERGE) enqueue gate-ready work. COMPLETE/mature is terminal metadata and does not dispatch another gate.';
