-- Rollback for 295-p3840-deliberate-gate-offers.sql  (P3840 Part 2)
--
-- (1) Drops the deliberate gate-review roles added by 295.
-- (2) Restores the mature WORK roles that 295 removed (exactly the rows from
--     the canonical seed 139-p748-agent-role-profile.sql that survived 294).
--
-- NOTE: this restores the pre-295 state (mature work roles present), which means
-- the orchestrator will resume dispatching work agents for mature proposals.
-- It does NOT restore the auto-gating DECISION roles — those were removed by
-- migration 294 and have their own rollback (294-*.rollback.sql). Run that too
-- if you intend to restore full pre-P3840 auto-advance behavior.

BEGIN;

-- (1) Drop the deliberate gate-review roles
DELETE FROM roadmap.agent_role_profile
WHERE scope = 'global'
  AND maturity = 'mature'
  AND role = 'gate-review'
  AND workflow_template_id IN (14, 37);

-- (2) Restore the mature WORK roles removed by 295 — the EXACT live set of 17
-- rows captured from roadmap.agent_role_profile before 295 was applied
-- (required_capabilities + priority preserved; NULL caps left NULL).
INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    -- Standard RFC (14)
    ('global', NULL, 14, 'DEVELOP', 'mature', 'developer',        ARRAY['code_generation','tool_use','refactoring'], 100),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'qa',               NULL, 30),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'skeptic-beta',     NULL, 10),
    ('global', NULL, 14, 'DRAFT',   'mature', 'drafter',          ARRAY['text_generation','structured_output'], 100),
    ('global', NULL, 14, 'DRAFT',   'mature', 'enrichment_agent', ARRAY['web_search','summarization','citation'], 110),
    ('global', NULL, 14, 'MERGE',   'mature', 'maintainer',       NULL, 30),
    ('global', NULL, 14, 'MERGE',   'mature', 'qa',               NULL, 20),
    ('global', NULL, 14, 'REVIEW',  'mature', 'architect',        NULL, 30),
    ('global', NULL, 14, 'REVIEW',  'mature', 'reviewer',         ARRAY['text_analysis','critique','structured_output'], 100),
    ('global', NULL, 14, 'REVIEW',  'mature', 'skeptic-alpha',    NULL, 10),
    -- Hotfix (37)
    ('global', NULL, 37, 'DEVELOP', 'mature', 'developer',        ARRAY['code_generation','tool_use','refactoring'], 100),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'qa',               NULL, 30),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'skeptic-beta',     NULL, 10),
    ('global', NULL, 37, 'DRAFT',   'mature', 'architect',        NULL, 10),
    ('global', NULL, 37, 'DRAFT',   'mature', 'drafter',          ARRAY['text_generation','structured_output'], 100),
    ('global', NULL, 37, 'DRAFT',   'mature', 'enrichment_agent', ARRAY['web_search','log_analysis','citation'], 110),
    ('global', NULL, 37, 'REVIEW',  'mature', 'reviewer',         ARRAY['text_analysis','critique','structured_output'], 100)
ON CONFLICT (workflow_template_id, stage, maturity, role)
    WHERE scope = 'global' AND project_id IS NULL
DO NOTHING;

COMMIT;
