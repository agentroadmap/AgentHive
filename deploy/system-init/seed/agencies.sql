-- Seed: agency providers and models
-- Run after 002-agency.sql is applied.
-- Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO agency.provider (slug, display_name, api_base_url, owner_did) VALUES
  ('claude',  'Anthropic Claude',   'https://api.anthropic.com',        'did:agenthive:system'),
  ('codex',   'OpenAI Codex',       'https://api.openai.com',           'did:agenthive:system'),
  ('hermes',  'Hermes (local)',      NULL,                               'did:agenthive:system'),
  ('copilot', 'GitHub Copilot',     'https://api.githubcopilot.com',    'did:agenthive:system')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO agency.model (provider_id, model_id, display_name, context_window, input_cost_per_1k, output_cost_per_1k, owner_did)
SELECT p.id, m.model_id, m.display_name, m.ctx, m.in_cost, m.out_cost, 'did:agenthive:system'
FROM agency.provider p
JOIN (VALUES
  ('claude',  'claude-opus-4-7',       'Claude Opus 4.7',      200000, 0.015000, 0.075000),
  ('claude',  'claude-sonnet-4-6',     'Claude Sonnet 4.6',    200000, 0.003000, 0.015000),
  ('claude',  'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 0.000800, 0.004000),
  ('codex',   'gpt-4o',                'GPT-4o',               128000, 0.005000, 0.015000),
  ('codex',   'o3',                    'OpenAI o3',            200000, 0.002000, 0.008000)
) AS m(provider_slug, model_id, display_name, ctx, in_cost, out_cost)
  ON p.slug = m.provider_slug
ON CONFLICT (model_id) DO NOTHING;

INSERT INTO agency.msg_kind (kind, description) VALUES
  ('heartbeat',       'Agency liveness pulse'),
  ('task_start',      'Agent claimed a proposal/task'),
  ('task_complete',   'Agent completed a proposal/task'),
  ('task_blocked',    'Agent encountered a blocker'),
  ('gate_request',    'Agent requests a gate review'),
  ('log',             'General log message from agency')
ON CONFLICT (kind) DO NOTHING;
