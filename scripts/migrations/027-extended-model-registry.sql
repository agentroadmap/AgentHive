-- Migration 027: Extended Model Registry
--
-- Changes:
--   1. Switch Xiaomi claude routes to anthropic-spec (api.xiaomi.com/anthropic/v1 confirmed)
--   2. Add OpenAI Codex CLI models (codex-mini-latest, o4-mini, o3, gpt-4.1 family)
--   3. Add extended GitHub Copilot models (claude-opus-4-6, gpt-5.4, gpt-4.1 family)
--   4. Add mimo TTS, code, and omni-lite variants
--   5. Add codex agent_provider routes for Codex CLI worktrees
--
-- Design note:
--   UNIQUE(model_name, route_provider, agent_provider) — one row per access path.
--   Xiaomi claude routes: agent_provider='claude' now uses anthropic-spec endpoint
--   (https://api.xiaomi.com/anthropic/v1). The spawner sets ANTHROPIC_BASE_URL
--   for non-default base URLs, so the native `claude` CLI handles the call.
--
--   Xiaomi openclaw/nous routes remain openai-spec (unchanged).
--   Codex CLI: new agent_provider='codex', openai-spec, all via OpenAI API.
--   GitHub Copilot: route_provider='github', openai-spec, token_plan priority.

BEGIN;

-- ── 1. Switch Xiaomi claude routes to anthropic-spec ─────────────────────────
-- api.xiaomi.com/anthropic/v1 is now confirmed. Update all existing xiaomi/claude
-- routes to use the anthropic-spec endpoint and flip api_spec accordingly.

UPDATE roadmap.model_routes
SET base_url   = 'https://api.xiaomi.com/anthropic/v1',
    api_spec   = 'anthropic',
    is_enabled = true,
    notes      = COALESCE(notes || ' | ', '') || 'Switched to anthropic-spec 2026-04-15'
WHERE route_provider = 'xiaomi'
  AND agent_provider = 'claude';

-- ── 2. Codex CLI models (OpenAI API, openai spec) ─────────────────────────────

INSERT INTO roadmap.model_metadata
  (model_name, provider, context_window, cost_per_1k_input, cost_per_1k_output)
VALUES
  ('codex-mini-latest', 'openai', 200000,  0.001500, 0.006000),
  ('o4-mini',           'openai', 200000,  0.001100, 0.004400),
  ('o3',                'openai', 200000,  0.010000, 0.040000),
  ('gpt-4.1',           'openai', 1047576, 0.002000, 0.008000),
  ('gpt-4.1-mini',      'openai', 1047576, 0.000400, 0.001600),
  ('gpt-4.1-nano',      'openai', 1047576, 0.000100, 0.000400),
  ('gpt-5.4',           'openai', 1047576, 0.005000, 0.020000)
ON CONFLICT (model_name) DO UPDATE
  SET cost_per_1k_input  = EXCLUDED.cost_per_1k_input,
      cost_per_1k_output = EXCLUDED.cost_per_1k_output,
      updated_at         = now();

-- ── 3. mimo TTS, code, and extra variants ─────────────────────────────────────

INSERT INTO roadmap.model_metadata
  (model_name, provider, context_window, cost_per_1k_input, cost_per_1k_output)
VALUES
  ('xiaomi/mimo-v2-tts',       'xiaomi', 32000,  0.000000, 0.000000),
  ('xiaomi/mimo-v2-code',      'xiaomi', 131072, 0.000000, 0.000000),
  ('xiaomi/mimo-v2-omni-lite', 'xiaomi', 131072, 0.000000, 0.000000)
ON CONFLICT (model_name) DO NOTHING;

-- ── 4. Routes — Codex CLI models (agent_provider='codex') ────────────────────
-- Codex CLI talks to OpenAI API (openai spec), base_url = https://api.openai.com/v1
-- Priority ladder: codex-mini (1) → o4-mini (2) → gpt-4.1-mini (3) → gpt-4.1 (5) → o3 (10)

INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('codex-mini-latest', 'openai', 'codex', 0.001500, 0.006000,
   'api_key', 1, true, 'https://api.openai.com/v1', 'openai',
   'Codex CLI default — fast coding model'),
  ('o4-mini', 'openai', 'codex', 0.001100, 0.004400,
   'api_key', 2, true, 'https://api.openai.com/v1', 'openai',
   'Codex CLI reasoning step-up'),
  ('gpt-4.1-mini', 'openai', 'codex', 0.000400, 0.001600,
   'api_key', 3, true, 'https://api.openai.com/v1', 'openai',
   'Codex CLI budget model'),
  ('gpt-4.1', 'openai', 'codex', 0.002000, 0.008000,
   'api_key', 5, true, 'https://api.openai.com/v1', 'openai',
   'Codex CLI standard model'),
  ('o3', 'openai', 'codex', 0.010000, 0.040000,
   'api_key', 10, true, 'https://api.openai.com/v1', 'openai',
   'Codex CLI max-capability escalation')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

-- ── 5. Routes — GitHub Copilot extended models (agent_provider='copilot') ────
-- GitHub Copilot exposes an OpenAI-compatible endpoint at api.githubcopilot.com.
-- token_plan = Copilot subscription (free quota). gpt-5.4 disabled until available.

INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('claude-opus-4-6',   'github', 'copilot', 0, 0, 'token_plan', 1, true,
   'https://api.githubcopilot.com', 'openai',
   'Claude Opus 4.6 via GitHub Copilot — token plan'),
  ('claude-sonnet-4-6', 'github', 'copilot', 0, 0, 'token_plan', 1, true,
   'https://api.githubcopilot.com', 'openai',
   'Claude Sonnet 4.6 via GitHub Copilot — token plan'),
  ('gpt-4.1',      'github', 'copilot', 0, 0, 'token_plan', 2, true,
   'https://api.githubcopilot.com', 'openai', 'GPT-4.1 via GitHub Copilot'),
  ('gpt-4.1-mini', 'github', 'copilot', 0, 0, 'token_plan', 1, true,
   'https://api.githubcopilot.com', 'openai', 'GPT-4.1 Mini via GitHub Copilot'),
  ('gpt-4.1-nano', 'github', 'copilot', 0, 0, 'token_plan', 1, true,
   'https://api.githubcopilot.com', 'openai', 'GPT-4.1 Nano via GitHub Copilot'),
  ('gpt-5.4',      'github', 'copilot', 0, 0, 'token_plan', 3, false,
   'https://api.githubcopilot.com', 'openai',
   'GPT-5.4 via GitHub Copilot — disabled until available'),
  ('gpt-4o',       'github', 'copilot', 0, 0, 'token_plan', 2, true,
   'https://api.githubcopilot.com', 'openai', 'GPT-4o via GitHub Copilot')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

-- Direct OpenAI API fallback routes for gpt-4.1 family (api_key, higher priority = lower priority number)
INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('gpt-4.1',      'openai', 'copilot', 0.002000, 0.008000,
   'api_key', 10, true, 'https://api.openai.com/v1', 'openai', 'GPT-4.1 via OpenAI API fallback'),
  ('gpt-4.1-mini', 'openai', 'copilot', 0.000400, 0.001600,
   'api_key', 10, true, 'https://api.openai.com/v1', 'openai', 'GPT-4.1 Mini via OpenAI API fallback'),
  ('gpt-4.1-nano', 'openai', 'copilot', 0.000100, 0.000400,
   'api_key', 10, true, 'https://api.openai.com/v1', 'openai', 'GPT-4.1 Nano via OpenAI API fallback'),
  ('gpt-5.4',      'openai', 'copilot', 0.005000, 0.020000,
   'api_key', 10, false, 'https://api.openai.com/v1', 'openai',
   'GPT-5.4 via OpenAI API — disabled until available')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

-- ── 6. Routes — mimo TTS, code, omni-lite via xiaomi (claude agent) ──────────
-- New variants use the anthropic-spec endpoint (consistent with step 1).

INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('xiaomi/mimo-v2-tts', 'xiaomi', 'claude', 0, 0,
   'token_plan', 1, true, 'https://api.xiaomi.com/anthropic/v1', 'anthropic',
   'Xiaomi MiMo TTS — anthropic-spec, free token plan'),
  ('xiaomi/mimo-v2-code', 'xiaomi', 'claude', 0, 0,
   'token_plan', 1, true, 'https://api.xiaomi.com/anthropic/v1', 'anthropic',
   'Xiaomi MiMo Code — anthropic-spec, free token plan'),
  ('xiaomi/mimo-v2-omni-lite', 'xiaomi', 'claude', 0, 0,
   'token_plan', 1, true, 'https://api.xiaomi.com/anthropic/v1', 'anthropic',
   'Xiaomi MiMo Omni Lite — anthropic-spec, free token plan')
ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE
  SET base_url   = EXCLUDED.base_url,
      api_spec   = EXCLUDED.api_spec,
      is_enabled = EXCLUDED.is_enabled;

-- ── 7. Routes — mimo code and omni-lite via nous (openclaw agents) ───────────

INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('xiaomi/mimo-v2-code', 'nous', 'openclaw', 0.000200, 0.000800,
   'api_key', 10, true, 'https://inference-api.nousresearch.com/v1', 'openai',
   'MiMo Code via Nous API — openclaw agents'),
  ('xiaomi/mimo-v2-omni-lite', 'nous', 'openclaw', 0.000150, 0.000600,
   'api_key', 10, true, 'https://inference-api.nousresearch.com/v1', 'openai',
   'MiMo Omni Lite via Nous API — openclaw agents')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

COMMIT;
