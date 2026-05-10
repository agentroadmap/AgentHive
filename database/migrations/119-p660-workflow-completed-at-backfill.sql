-- P660: Backfill completed_at for workflow rows stuck in terminal stages.
-- A terminal stage has no outgoing rows in roadmap.workflow_transitions.
-- Idempotent: re-running returns 0 rows updated.
UPDATE roadmap.workflows w
SET    completed_at = NOW()
WHERE  w.completed_at IS NULL
  AND  NOT EXISTS (
         SELECT 1
         FROM   roadmap.workflow_transitions wt
         WHERE  wt.template_id  = w.template_id
           AND  LOWER(wt.from_stage) = LOWER(w.current_stage)
       );
