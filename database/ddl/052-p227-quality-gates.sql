-- P227: Workflow quality gates — mandatory CODE_REVIEW, TEST_WRITING, TEST_EXECUTION
-- stages across Standard RFC and TEST_EXECUTION stage in Hotfix workflow.
--
-- Standard RFC (template_id=14) before: DRAFT(1) REVIEW(2) DEVELOP(3) MERGE(4) COMPLETE(5)
-- Standard RFC (template_id=14) after:  DRAFT(1) REVIEW(2) DEVELOP(3) CODE_REVIEW(4) TEST_WRITING(5) TEST_EXECUTION(6) MERGE(7) COMPLETE(8)
--
-- Hotfix (template_id=37) before: TRIAGE(1) FIX(2) DEPLOYED(3)
-- Hotfix (template_id=37) after:  TRIAGE(1) FIX(2) TEST_EXECUTION(3) DEPLOYED(4)

BEGIN;

-- ─── Standard RFC: bump MERGE and COMPLETE to make room ─────────────────────

UPDATE roadmap.workflow_stages
   SET stage_order = 7
 WHERE template_id = 14 AND stage_name = 'MERGE';

UPDATE roadmap.workflow_stages
   SET stage_order = 8
 WHERE template_id = 14 AND stage_name = 'COMPLETE';

-- ─── Standard RFC: insert the three new quality-gate stages ──────────────────

INSERT INTO roadmap.workflow_stages
    (template_id, stage_name, stage_order, requires_ac, maturity_gate, gating_config)
VALUES
    (14, 'CODE_REVIEW',    4, false, 1, '{"mode":"auto","required_ac_pass_rate":1.0}'::jsonb),
    (14, 'TEST_WRITING',   5, false, 1, '{"mode":"auto","required_ac_pass_rate":1.0}'::jsonb),
    (14, 'TEST_EXECUTION', 6, true,  1, '{"mode":"auto","required_ac_pass_rate":1.0}'::jsonb);

-- ─── Standard RFC: update stage_count ────────────────────────────────────────

UPDATE roadmap.workflow_templates
   SET stage_count = 8
 WHERE id = 14;

-- ─── Hotfix: bump DEPLOYED to make room ──────────────────────────────────────

UPDATE roadmap.workflow_stages
   SET stage_order = 4
 WHERE template_id = 37 AND stage_name = 'DEPLOYED';

-- ─── Hotfix: insert TEST_EXECUTION before DEPLOYED ───────────────────────────

INSERT INTO roadmap.workflow_stages
    (template_id, stage_name, stage_order, requires_ac, maturity_gate, gating_config)
VALUES
    (37, 'TEST_EXECUTION', 3, true, 1, '{"mode":"auto","required_ac_pass_rate":1.0}'::jsonb);

-- ─── Hotfix: update stage_count ──────────────────────────────────────────────

UPDATE roadmap.workflow_templates
   SET stage_count = stage_count + 1
 WHERE id = 37;

-- ─── Standard RFC: update smdl_definition JSONB ──────────────────────────────

UPDATE roadmap.workflow_templates
   SET smdl_definition = jsonb_set(
         jsonb_set(
           -- Update existing stage orders: MERGE 4→7, COMPLETE 5→8
           jsonb_set(
             smdl_definition,
             '{workflow,stages}',
             (
               SELECT jsonb_agg(
                 CASE
                   WHEN s->>'name' = 'MERGE'     THEN s || '{"order":7}'::jsonb
                   WHEN s->>'name' = 'COMPLETE'  THEN s || '{"order":8}'::jsonb
                   ELSE s
                 END
               )
               FROM jsonb_array_elements(smdl_definition->'workflow'->'stages') AS s
             )
           ),
           -- Append new stages
           '{workflow,stages}',
           (
             SELECT jsonb_agg(s ORDER BY (s->>'order')::int)
             FROM (
               SELECT jsonb_array_elements(
                 (
                   SELECT jsonb_set(
                     smdl_definition,
                     '{workflow,stages}',
                     (
                       SELECT jsonb_agg(
                         CASE
                           WHEN s->>'name' = 'MERGE'    THEN s || '{"order":7}'::jsonb
                           WHEN s->>'name' = 'COMPLETE' THEN s || '{"order":8}'::jsonb
                           ELSE s
                         END
                       )
                       FROM jsonb_array_elements(smdl_definition->'workflow'->'stages') AS s
                     )
                   )
                   FROM roadmap.workflow_templates WHERE id = 14
                 )->'workflow'->'stages'
               )
               UNION ALL
               SELECT '{"name":"CODE_REVIEW","order":4,"description":"Peer code review by a different agent","requires_ac":false}'::jsonb
               UNION ALL
               SELECT '{"name":"TEST_WRITING","order":5,"description":"Write and commit acceptance test cases","requires_ac":false}'::jsonb
               UNION ALL
               SELECT '{"name":"TEST_EXECUTION","order":6,"description":"Execute AC tests; all must pass before merge","requires_ac":true}'::jsonb
             ) AS sub(s)
           )
         ),
         -- Update transitions: replace DEVELOP→MERGE forward edge with quality-gate chain
         '{workflow,transitions}',
         (
           SELECT jsonb_agg(
             CASE
               WHEN t->>'from' = 'DEVELOP' AND t->>'to' = 'MERGE'
                    AND t->'labels' @> '["mature"]'::jsonb
               THEN t || '{"to":"CODE_REVIEW"}'::jsonb
               ELSE t
             END
           ) ||
           -- Add new forward transitions
           '[
             {"from":"CODE_REVIEW","to":"TEST_WRITING","labels":["mature","approved"],"allowed_roles":["any"]},
             {"from":"CODE_REVIEW","to":"DEVELOP","labels":["iterate","request_changes"],"allowed_roles":["any"]},
             {"from":"TEST_WRITING","to":"TEST_EXECUTION","labels":["mature","tests_written"],"allowed_roles":["any"]},
             {"from":"TEST_EXECUTION","to":"MERGE","labels":["mature","tests_pass"],"requires_ac":true,"allowed_roles":["PM","Architect"]},
             {"from":"TEST_EXECUTION","to":"DEVELOP","labels":["iterate","tests_fail"],"allowed_roles":["any"]}
           ]'::jsonb
           FROM jsonb_array_elements(smdl_definition->'workflow'->'transitions') AS t
         )
       )
 WHERE id = 14;

-- ─── Hotfix: update smdl_definition JSONB ────────────────────────────────────

UPDATE roadmap.workflow_templates
   SET smdl_definition = jsonb_set(
         jsonb_set(
           -- Bump DEPLOYED order 3→4 in stages array
           jsonb_set(
             smdl_definition,
             '{workflow,stages}',
             (
               SELECT jsonb_agg(
                 CASE
                   WHEN s->>'name' = 'DEPLOYED' THEN s || '{"order":4}'::jsonb
                   ELSE s
                 END
               )
               FROM jsonb_array_elements(smdl_definition->'workflow'->'stages') AS s
             )
           ),
           -- Append TEST_EXECUTION stage
           '{workflow,stages}',
           (
             SELECT jsonb_agg(s ORDER BY (s->>'order')::int)
             FROM (
               SELECT jsonb_array_elements(
                 (
                   SELECT jsonb_set(
                     smdl_definition,
                     '{workflow,stages}',
                     (
                       SELECT jsonb_agg(
                         CASE
                           WHEN s->>'name' = 'DEPLOYED' THEN s || '{"order":4}'::jsonb
                           ELSE s
                         END
                       )
                       FROM jsonb_array_elements(smdl_definition->'workflow'->'stages') AS s
                     )
                   )
                   FROM roadmap.workflow_templates WHERE id = 37
                 )->'workflow'->'stages'
               )
               UNION ALL
               SELECT '{"name":"TEST_EXECUTION","order":3,"description":"Run AC tests before deployment","requires_ac":true}'::jsonb
             ) AS sub(s)
           )
         ),
         -- Update transitions: replace FIX→DEPLOYED with FIX→TEST_EXECUTION + TEST_EXECUTION→DEPLOYED
         '{workflow,transitions}',
         (
           SELECT jsonb_agg(
             CASE
               WHEN t->>'from' = 'FIX' AND t->>'to' = 'DEPLOYED'
                    AND t->'labels' @> '["mature"]'::jsonb
               THEN t || '{"to":"TEST_EXECUTION"}'::jsonb
               ELSE t
             END
           ) ||
           '[
             {"from":"TEST_EXECUTION","to":"DEPLOYED","labels":["mature","tests_pass"],"requires_ac":true,"allowed_roles":["any"]},
             {"from":"TEST_EXECUTION","to":"FIX","labels":["iterate","tests_fail"],"allowed_roles":["any"]}
           ]'::jsonb
           FROM jsonb_array_elements(smdl_definition->'workflow'->'transitions') AS t
         )
       )
 WHERE id = 37;

-- ─── Seed ac-test-executor in tool_agent_config ──────────────────────────────

INSERT INTO roadmap.tool_agent_config
    (agent_identity, agent_type, trigger_type, trigger_source, handler_class, is_active, config)
VALUES
    (
        'tool/ac-test-executor',
        'tool',
        'queue',
        'AC_TEST',
        'AcTestExecutor',
        true,
        '{"testTimeout":120000,"passThreshold":1.0}'::jsonb
    )
ON CONFLICT (agent_identity) DO UPDATE
   SET handler_class = EXCLUDED.handler_class,
       config        = EXCLUDED.config,
       is_active     = true;

INSERT INTO roadmap.agent_registry
    (agent_identity, agent_type, skills, status)
VALUES
    (
        'tool/ac-test-executor',
        'tool',
        '["ac-test-execution","test-result-parsing","pass-fail-reporting"]'::jsonb,
        'active'
    )
ON CONFLICT (agent_identity) DO UPDATE
   SET skills = EXCLUDED.skills,
       status = 'active';

-- ─── Notify state-names registry of the change ───────────────────────────────

SELECT pg_notify('workflow_templates_changed', 'p227_quality_gates');

COMMIT;
