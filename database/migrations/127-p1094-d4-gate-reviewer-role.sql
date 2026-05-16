-- P1094: Re-enable the D4 MERGE -> COMPLETE reviewer binding.
--
-- The D4 gate role table resolves MERGE/mature to `gate-reviewer`, but the
-- queue-role table had only reviewer-d4/qa/maintainer/gate-agent plus the older
-- merge_decision_agent seed. Keep those fallbacks, but make the canonical D4
-- role the first profile returned for Standard RFC MERGE/mature.

BEGIN;

INSERT INTO roadmap.agent_role_profile
  (scope, workflow_template_id, stage, maturity, role, required_capabilities, prompt_template, priority)
VALUES
  (
    'global',
    14,
    'MERGE',
    'mature',
    'gate-reviewer',
    ARRAY['gating', 'review', 'devops', 'ops', 'qa', 'e2e-testing', 'regression-testing'],
    '{"system": "You are the D4 integration gate reviewer. Validate that the proposal has actually merged, integration tests pass, and the feature is deployable before MERGE -> COMPLETE.", "mode": "d4_merge_gate"}'::jsonb,
    5
  )
ON CONFLICT (workflow_template_id, stage, maturity, role)
  WHERE scope = 'global' AND project_id IS NULL
DO UPDATE SET
  required_capabilities = EXCLUDED.required_capabilities,
  prompt_template = EXCLUDED.prompt_template,
  priority = EXCLUDED.priority,
  updated_at = now();

UPDATE roadmap_workforce.agent_registry
   SET role = 'gate-reviewer',
       skills = COALESCE(skills, '[]'::jsonb) || '["gating","review","devops","ops","qa","e2e-testing","regression-testing"]'::jsonb,
       status = 'active',
       updated_at = now()
 WHERE agent_identity = 'Gate Reviewer';

INSERT INTO roadmap_workforce.agent_registry
  (agent_identity, agent_type, role, skills, status, trust_tier)
SELECT
  'gate-reviewer',
  'llm',
  'gate-reviewer',
  '["gating","review","devops","ops","qa","e2e-testing","regression-testing"]'::jsonb,
  'active',
  'trusted'
WHERE NOT EXISTS (
  SELECT 1
    FROM roadmap_workforce.agent_registry
   WHERE status = 'active'
     AND role = 'gate-reviewer'
);

COMMIT;
