-- Rollback for 294-p3840-remove-auto-gating-roles.sql
--
-- Re-seeds the gate-decision roles to RE-ENABLE auto-gating. This is a
-- best-effort FUNCTIONAL restore reconstructed from the canonical seed
-- (092-p748-agent-role-profile.sql) plus the decision-agent definitions; the
-- original rows' exact prompt_template/id values are approximated. Run only if
-- you intend to restore the pre-P3840 auto-advance behavior.

BEGIN;

-- Standard RFC (template 14) gate reviewers (D1-D4) + gate-agent
INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    ('global', NULL, 14, 'DRAFT',   'mature', 'reviewer-d1', ARRAY['review','gating'],      20),
    ('global', NULL, 14, 'REVIEW',  'mature', 'reviewer-d2', ARRAY['design','architecture'],20),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'reviewer-d3', ARRAY['review','gating'],      20),
    ('global', NULL, 14, 'MERGE',   'mature', 'reviewer-d4', ARRAY['review','gating'],      10),
    ('global', NULL, 14, 'MERGE',   'mature', 'gate-agent',  ARRAY['gating'],               40)
ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

-- Hotfix (template 37) gate reviewers
INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, priority)
VALUES
    ('global', NULL, 37, 'DRAFT',   'mature', 'reviewer-d1', ARRAY['review','gating'], 20),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'reviewer-d3', ARRAY['review','gating'], 20),
    ('global', NULL, 37, 'MERGE',   'mature', 'reviewer-d4', ARRAY['review','gating'], 10)
ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

-- Explicit gate-decision agents (D2 review-gate, D4 merge-gate) + canonical D4 gate-reviewer
INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role, required_capabilities, prompt_template, priority)
VALUES
    ('global', NULL, 14, 'REVIEW', 'new',    'gate_decision_agent', ARRAY['decision_making','structured_output'], '{"mode":"review_gate","system":"You decide whether new RFC proposals are ready to advance to DEVELOP."}', 90),
    ('global', NULL, 14, 'REVIEW', 'mature', 'gate_decision_agent', ARRAY['decision_making','structured_output'], '{"mode":"review_gate_mature","system":"You make REVIEW->DEVELOP gate decisions for mature RFC proposals; require quorum of 2 reviewers incl. a skeptic and no blocking reviews."}', 90),
    ('global', NULL, 37, 'REVIEW', 'new',    'gate_decision_agent', ARRAY['decision_making','structured_output'], '{"mode":"hotfix_gate","system":"You make fast gate decisions for new hotfix proposals under time pressure."}', 90),
    ('global', NULL, 37, 'REVIEW', 'mature', 'gate_decision_agent', ARRAY['decision_making','structured_output'], '{"mode":"hotfix_gate_mature","system":"You make gate decisions for mature hotfix proposals."}', 90),
    ('global', NULL, 14, 'MERGE',  'new',    'merge_decision_agent', ARRAY['decision_making','code_review'], '{"mode":"merge_gate","system":"You decide whether new RFC implementations are ready to merge."}', 90),
    ('global', NULL, 14, 'MERGE',  'mature', 'merge_decision_agent', ARRAY['decision_making','code_review','structured_output'], '{"mode":"merge_gate_mature","system":"You make final merge decisions for mature RFC implementations."}', 90),
    ('global', NULL, 37, 'MERGE',  'new',    'merge_decision_agent', ARRAY['decision_making','code_review'], '{"mode":"merge_gate","system":"You decide whether new hotfix implementations are ready to merge."}', 90),
    ('global', NULL, 37, 'MERGE',  'mature', 'merge_decision_agent', ARRAY['decision_making','code_review','structured_output'], '{"mode":"merge_gate_mature","system":"You make final merge decisions for mature hotfix implementations."}', 90),
    ('global', NULL, 14, 'MERGE',  'mature', 'gate-reviewer', ARRAY['review','gating'], '{"mode":"d4_gate","system":"You are the canonical D4 (MERGE) gate reviewer."}', 5)
ON CONFLICT ON CONSTRAINT agent_role_profile_unique DO NOTHING;

COMMIT;
