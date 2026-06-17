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

-- (2) Restore the mature WORK roles removed by 295
INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, priority)
VALUES
    -- Standard RFC (14)
    ('global', NULL, 14, 'DRAFT',   'mature', 'architect',     10),
    ('global', NULL, 14, 'REVIEW',  'mature', 'skeptic-alpha', 10),
    ('global', NULL, 14, 'REVIEW',  'mature', 'architect',     30),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'skeptic-beta',  10),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'qa',            30),
    ('global', NULL, 14, 'MERGE',   'mature', 'qa',            20),
    ('global', NULL, 14, 'MERGE',   'mature', 'maintainer',    30),
    -- Hotfix (37)
    ('global', NULL, 37, 'DRAFT',   'mature', 'architect',     10),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'skeptic-beta',  10),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'qa',            30)
ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

COMMIT;
