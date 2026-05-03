-- Seed: default agent records and skills for a new project.
-- Substitutes :schema_name with the project schema.
-- Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO :schema_name.agent (slug, display_name, provider_slug, model_id, kind)
VALUES
  ('claude-dev',      'Claude Developer',      'claude',  'claude-sonnet-4-6',     'developer'),
  ('claude-reviewer', 'Claude Reviewer',       'claude',  'claude-sonnet-4-6',     'reviewer'),
  ('claude-gate',     'Claude Gate Reviewer',  'claude',  'claude-opus-4-7',       'gate-reviewer'),
  ('codex-dev',       'Codex Developer',       'codex',   'o3',                    'developer'),
  ('orchestrator',    'AgentHive Orchestrator','claude',  'claude-sonnet-4-6',     'orchestrator')
ON CONFLICT (slug) DO NOTHING;

-- Grant gate-review skill to the gate reviewer agent
WITH a AS (SELECT id FROM :schema_name.agent WHERE slug = 'claude-gate')
INSERT INTO :schema_name.aSkill (agent_id, skill, proficiency, granted_by)
SELECT a.id, s.skill, s.prof, 'seed'
FROM a, (VALUES
  ('gate-review',  'expert'),
  ('architecture', 'expert'),
  ('typescript',   'capable')
) AS s(skill, prof)
ON CONFLICT (agent_id, skill) DO NOTHING;

-- Grant development skills to developer agents
WITH a AS (SELECT id FROM :schema_name.agent WHERE slug = 'claude-dev')
INSERT INTO :schema_name.aSkill (agent_id, skill, proficiency, granted_by)
SELECT a.id, s.skill, s.prof, 'seed'
FROM a, (VALUES
  ('typescript', 'expert'),
  ('postgres',   'expert'),
  ('react',      'capable')
) AS s(skill, prof)
ON CONFLICT (agent_id, skill) DO NOTHING;

-- Seed default topics
INSERT INTO :schema_name.mTopic (slug, description, retention_days)
VALUES
  ('proposal-updates', 'Proposal status change events',   90),
  ('gate-events',      'Gate decision and review events', 365),
  ('agent-activity',   'Agent task start/complete/block', 30)
ON CONFLICT (slug) DO NOTHING;
