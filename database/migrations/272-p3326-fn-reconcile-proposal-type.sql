-- Migration 272: P3326 AC-5 — fn_reconcile_proposal_type + drift audit
-- Fixes workflow drift where workflows.template_id points to the wrong workflow template
-- (e.g., Architecture RFC instead of Standard RFC) for a proposal's actual type.
-- Also provides a drift audit view for operational monitoring.

-- ---------------------------------------------------------------------------
-- Reconcile function: atomically update proposal.type + workflows.template_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_reconcile_proposal_type(
  p_proposal_id  INT,
  p_target_type  TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_workflow_name  TEXT;
  v_template_id    INT;
  v_old_type       TEXT;
  v_old_template   INT;
  v_old_name       TEXT;
BEGIN
  -- Resolve target workflow from proposal_type_config
  SELECT ptc.workflow_name
    INTO v_workflow_name
    FROM roadmap.proposal_type_config ptc
   WHERE LOWER(ptc.proposal_type) = LOWER(p_target_type)
   LIMIT 1;

  IF v_workflow_name IS NULL THEN
    -- Fall back to Standard RFC for unmapped types (feature, bug-fix, etc.)
    v_workflow_name := 'Standard RFC';
  END IF;

  -- Resolve template_id for the target workflow name
  SELECT wt.id
    INTO v_template_id
    FROM roadmap.workflow_templates wt
   WHERE LOWER(wt.name) = LOWER(v_workflow_name)
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'fn_reconcile_proposal_type: no workflow_template found for workflow_name=% (type=%)',
      v_workflow_name, p_target_type;
  END IF;

  -- Capture current state for return message
  SELECT p.type, w.template_id, wt.name
    INTO v_old_type, v_old_template, v_old_name
    FROM roadmap_proposal.proposals p
    JOIN roadmap.workflows w ON w.proposal_id = p.id
    JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
   WHERE p.id = p_proposal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_reconcile_proposal_type: proposal % not found or has no workflow row', p_proposal_id;
  END IF;

  -- Atomically update both proposal.type and workflows.template_id
  UPDATE roadmap_proposal.proposals
     SET type = p_target_type
   WHERE id = p_proposal_id;

  UPDATE roadmap.workflows
     SET template_id = v_template_id
   WHERE proposal_id = p_proposal_id;

  RETURN format(
    'reconciled proposal %s: type %s→%s, template_id %s(%s)→%s(%s)',
    p_proposal_id,
    v_old_type, p_target_type,
    v_old_template, v_old_name,
    v_template_id, v_workflow_name
  );
END;
$$;

COMMENT ON FUNCTION roadmap.fn_reconcile_proposal_type(INT, TEXT) IS
  'P3326: atomically fix workflow drift by updating both proposal.type and workflows.template_id '
  'to match the canonical workflow for the target type. Unmapped types default to Standard RFC.';

-- ---------------------------------------------------------------------------
-- Drift audit view: proposals where workflows.template_id disagrees with type
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_workflow_type_drift AS
SELECT
  p.id                                          AS proposal_id,
  p.display_id,
  p.type                                        AS proposal_type,
  p.status,
  wt_actual.name                                AS actual_template,
  COALESCE(ptc.workflow_name, 'Standard RFC')   AS expected_template,
  wt_expected.id                                AS expected_template_id,
  wt_actual.id                                  AS actual_template_id,
  (wt_actual.id <> wt_expected.id)              AS is_drifted
FROM roadmap_proposal.proposals p
JOIN roadmap.workflows w          ON w.proposal_id = p.id
JOIN roadmap.workflow_templates wt_actual ON wt_actual.id = w.template_id
LEFT JOIN roadmap.proposal_type_config ptc
       ON LOWER(ptc.proposal_type) = LOWER(p.type)
LEFT JOIN roadmap.workflow_templates wt_expected
       ON LOWER(wt_expected.name) = LOWER(COALESCE(ptc.workflow_name, 'Standard RFC'))
WHERE p.status NOT IN ('COMPLETE', 'OBSOLETE', 'CANCELLED');

COMMENT ON VIEW roadmap.v_workflow_type_drift IS
  'P3326 drift audit: non-terminal proposals where workflows.template_id does not match the '
  'canonical template for proposal.type. Run: SELECT * FROM roadmap.v_workflow_type_drift WHERE is_drifted;';
