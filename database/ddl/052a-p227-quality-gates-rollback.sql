-- Rollback of 052-p227-quality-gates.sql for Standard RFC (template_id=14).
-- Applied 2026-05-06 by gary in a2aTest session.
--
-- Reason: the DDL added CODE_REVIEW / TEST_WRITING / TEST_EXECUTION as hardcoded
-- workflow stages, but P227's stated design is "Workflow quality checks as queue
-- roles, not extra hardcoded workflow stages." Implementation contradicted the
-- proposal. P227 has been bumped DEVELOP → DRAFT for redesign as a queue-role
-- mechanism.
--
-- Hotfix arm of 052 is NOT rolled back here — workflow_stages for template_id=37
-- already showed canonical DRAFT/DEVELOP/COMPLETE before this rollback ran, so
-- that part of 052 either never applied or was already reverted by other means.
--
-- ⚠️  Do NOT re-apply 052-p227-quality-gates.sql without first changing P227's
-- design to match the implementation, or rewriting the DDL to match the design.

BEGIN;

-- 1. Delete the three injected stages
DELETE FROM roadmap.workflow_stages
 WHERE template_id = 14
   AND stage_name IN ('CODE_REVIEW','TEST_WRITING','TEST_EXECUTION');

-- 2. Restore canonical orders for MERGE / COMPLETE
UPDATE roadmap.workflow_stages SET stage_order = 4 WHERE template_id = 14 AND stage_name = 'MERGE';
UPDATE roadmap.workflow_stages SET stage_order = 5 WHERE template_id = 14 AND stage_name = 'COMPLETE';

-- 3. Restore stage_count
UPDATE roadmap.workflow_templates SET stage_count = 5 WHERE id = 14;

-- 4. Repair smdl_definition: filter stages, fix orders, filter transitions, restore DEVELOP→MERGE
UPDATE roadmap.workflow_templates
   SET smdl_definition = jsonb_set(
         jsonb_set(
           smdl_definition,
           '{workflow,stages}',
           (
             SELECT jsonb_agg(
                      CASE
                        WHEN s->>'name' = 'MERGE'    THEN s || '{"order":4}'::jsonb
                        WHEN s->>'name' = 'COMPLETE' THEN s || '{"order":5}'::jsonb
                        ELSE s
                      END
                      ORDER BY (
                        CASE
                          WHEN s->>'name' = 'MERGE'    THEN 4
                          WHEN s->>'name' = 'COMPLETE' THEN 5
                          ELSE (s->>'order')::int
                        END
                      )
                    )
               FROM jsonb_array_elements(smdl_definition->'workflow'->'stages') AS s
              WHERE s->>'name' NOT IN ('CODE_REVIEW','TEST_WRITING','TEST_EXECUTION')
           )
         ),
         '{workflow,transitions}',
         (
           SELECT jsonb_agg(t)
             FROM jsonb_array_elements(smdl_definition->'workflow'->'transitions') AS t
            WHERE NOT (
                 t->>'from' IN ('CODE_REVIEW','TEST_WRITING','TEST_EXECUTION')
              OR t->>'to'   IN ('CODE_REVIEW','TEST_WRITING','TEST_EXECUTION')
            )
         )
       )
 WHERE id = 14;

-- 5. Restore the DEVELOP→MERGE forward transition
--    (DDL 052 had repointed it to DEVELOP→CODE_REVIEW, so simple filtering doesn't bring it back.)
UPDATE roadmap.workflow_templates
   SET smdl_definition = jsonb_set(
         smdl_definition,
         '{workflow,transitions}',
         (smdl_definition->'workflow'->'transitions') ||
         '[{"from":"DEVELOP","to":"MERGE","labels":["mature","decision"],"requires_ac":true,"allowed_roles":["PM","Architect"]}]'::jsonb
       )
 WHERE id = 14
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(smdl_definition->'workflow'->'transitions') t
      WHERE t->>'from' = 'DEVELOP' AND t->>'to' = 'MERGE'
   );

-- 6. Sync description back to "5-stage"
UPDATE roadmap.workflow_templates
   SET description = '5-stage RFC pipeline for product development'
 WHERE id = 14;

-- 7. Notify any listening services that the templates changed
SELECT pg_notify('workflow_templates_changed', 'p227_quality_gates_reverted');

COMMIT;
