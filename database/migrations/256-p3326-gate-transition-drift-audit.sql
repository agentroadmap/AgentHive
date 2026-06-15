-- P3326: Gate/transition workflow drift audit and reconciliation.
--
-- Defect: proposals with type != 'architecture' that were assigned the
-- Architecture RFC workflow template (no DEVELOP stage) cannot advance
-- through REVIEW→DEVELOP, and gate_decision D2 would overshoot to COMPLETE.
--
-- This migration:
--   1. Logs a summary of detected drift to the migration ledger comment.
--   2. Reconciles non-terminal proposals by updating their workflows.template_id
--      to the Standard RFC template when their type implies Standard RFC.
--
-- Audit-only query (run manually to review before applying fix):
--   SELECT p.id, p.display_id, p.type, p.status, wt.name AS current_template
--     FROM roadmap_proposal.proposal p
--     JOIN roadmap.workflows w ON w.proposal_id = p.id
--     JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
--    WHERE p.type NOT IN ('architecture')
--      AND wt.name = 'Architecture RFC'
--      AND p.status NOT IN ('COMPLETE', 'OBSOLETE');

DO $$
DECLARE
  v_standard_rfc_id  integer;
  v_arch_rfc_name    text := 'Architecture RFC';
  v_std_rfc_name     text := 'Standard RFC';
  v_drift_count      integer;
BEGIN
  -- Resolve Standard RFC template id (fail fast if not found).
  SELECT id INTO v_standard_rfc_id
    FROM roadmap.workflow_templates
   WHERE name = v_std_rfc_name
   LIMIT 1;

  IF v_standard_rfc_id IS NULL THEN
    RAISE EXCEPTION 'P3326 migration: Standard RFC workflow template not found — cannot reconcile.';
  END IF;

  -- Count drifted proposals (non-terminal, non-architecture type on Architecture RFC template).
  SELECT COUNT(*) INTO v_drift_count
    FROM roadmap_proposal.proposal p
    JOIN roadmap.workflows w ON w.proposal_id = p.id
    JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
   WHERE p.type NOT IN ('architecture')
     AND wt.name = v_arch_rfc_name
     AND p.status NOT IN ('COMPLETE', 'OBSOLETE');

  IF v_drift_count > 0 THEN
    RAISE NOTICE 'P3326: remapping % non-terminal proposal(s) from Architecture RFC → Standard RFC', v_drift_count;

    -- Remap: set template_id to Standard RFC. Preserve current_stage (it maps
    -- to the same stage names across both templates for shared stages like REVIEW).
    UPDATE roadmap.workflows w
       SET template_id = v_standard_rfc_id
      FROM roadmap_proposal.proposal p
      JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
     WHERE w.proposal_id = p.id
       AND p.type NOT IN ('architecture')
       AND wt.name = v_arch_rfc_name
       AND p.status NOT IN ('COMPLETE', 'OBSOLETE');

    RAISE NOTICE 'P3326: remapped % proposals. Re-run the audit query to verify.', v_drift_count;
  ELSE
    RAISE NOTICE 'P3326: no type→workflow drift found. All non-architecture proposals are on the correct template.';
  END IF;
END;
$$;
