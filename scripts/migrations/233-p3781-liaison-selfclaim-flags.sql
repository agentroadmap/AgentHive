-- P3781 AC-2: Seed LIAISON_LLM_TIMEOUT_MS and SELF_CLAIM_AGENCIES as runtime flags
-- Migrates the last two feature flags from direct process.env reads to config system.
-- Idempotent: ON CONFLICT (flag_name) DO NOTHING; safe to re-run.

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, category, description) VALUES

  ('LIAISON_LLM_TIMEOUT_MS', '30000', 'global', 'active', 'liaison',
   'Default LLM call timeout for liaison agents (ms). Per-provider env AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_<PROVIDER> takes precedence. Valid range: 1000-600000.'),

  ('SELF_CLAIM_AGENCIES', '""', 'global', 'active', 'dispatch',
   'Comma-separated agency identities allowed to self-claim work offers (V3-C6 canary). Empty string = all agencies allowed.')

ON CONFLICT (flag_name) DO NOTHING;
