-- Migration 039: DB-driven credential mapping, spawn toolset control, and route enablement
--
-- Goals:
--   1. Eliminate hardcoded API-key env var mappings from agent-spawner.ts.
--   2. Control which Hermes toolsets spawned agents receive (exclude delegation).
--   3. Enable xiaomi routes per host policy and fix costs.
--   4. Add spawn_toolsets so the DB controls agent capabilities.

BEGIN;

-- ── 1. New columns ──────────────────────────────────────────────────────────

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS api_key_env            TEXT,
  ADD COLUMN IF NOT EXISTS api_key_fallback_env   TEXT,
  ADD COLUMN IF NOT EXISTS base_url_env           TEXT,
  ADD COLUMN IF NOT EXISTS spawn_toolsets         TEXT;

COMMENT ON COLUMN roadmap.model_routes.api_key_env IS
  'Primary env var name for the API key (e.g. NOUS_API_KEY, ANTHROPIC_API_KEY).';
COMMENT ON COLUMN roadmap.model_routes.api_key_fallback_env IS
  'Fallback env var name, usually OPENAI_API_KEY for OpenAI-compatible endpoints.';
COMMENT ON COLUMN roadmap.model_routes.base_url_env IS
  'Env var used to override the base URL (e.g. OPENAI_BASE_URL, ANTHROPIC_BASE_URL).';
COMMENT ON COLUMN roadmap.model_routes.spawn_toolsets IS
  'Comma-separated Hermes toolsets granted to agents spawned on this route. Empty/null = defaults.';

-- ── 2. Backfill credential env vars per api_spec / route_provider ───────────

UPDATE roadmap.model_routes
SET api_key_env          = 'ANTHROPIC_API_KEY',
    base_url_env         = 'ANTHROPIC_BASE_URL'
WHERE api_spec = 'anthropic';

UPDATE roadmap.model_routes
SET api_key_env          = 'GEMINI_API_KEY'
WHERE api_spec = 'google';

UPDATE roadmap.model_routes
SET api_key_env          = 'NOUS_API_KEY',
    api_key_fallback_env = 'OPENAI_API_KEY',
    base_url_env         = 'OPENAI_BASE_URL'
WHERE route_provider = 'nous';

UPDATE roadmap.model_routes
SET api_key_env          = 'XIAOMI_API_KEY',
    api_key_fallback_env = 'OPENAI_API_KEY',
    base_url_env         = 'OPENAI_BASE_URL'
WHERE route_provider = 'xiaomi';

UPDATE roadmap.model_routes
SET api_key_env          = 'OPENAI_API_KEY',
    base_url_env         = 'OPENAI_BASE_URL'
WHERE route_provider = 'openai';

UPDATE roadmap.model_routes
SET api_key_env          = 'GITHUB_TOKEN',
    api_key_fallback_env = 'OPENAI_API_KEY',
    base_url_env         = 'OPENAI_BASE_URL'
WHERE route_provider = 'github';

-- ── 3. Toolset control: deny delegation so subagent spawn must go through spawnAgent
UPDATE roadmap.model_routes
SET spawn_toolsets = 'web,browser,terminal,file,code_execution,vision,image_gen,tts,skills,todo,memory,session_search,clarify,cronjob,messaging'
WHERE agent_cli = 'hermes';

-- ── 4. Enable xiaomi routes for hosts that allow nous & xiaomi ─────────────
--    hermes agent_provider → nous route (pay-per-use API)
UPDATE roadmap.model_routes
SET is_enabled = true
WHERE model_name IN ('xiaomi/mimo-v2-pro', 'xiaomi/mimo-v2-omni')
  AND route_provider = 'nous'
  AND agent_provider = 'hermes';

--    claude agent_provider → xiaomi route (token plan)
UPDATE roadmap.model_routes
SET is_enabled = true
WHERE model_name IN ('xiaomi/mimo-v2-pro', 'xiaomi/mimo-v2-omni')
  AND route_provider = 'xiaomi'
  AND agent_provider = 'claude';

-- ── 5. Fix costs for xiaomi routes via nous (source: model_metadata) ───────
UPDATE roadmap.model_routes
SET cost_per_million_input  = 1.000000,
    cost_per_million_output = 2.000000
WHERE model_name = 'xiaomi/mimo-v2-pro'
  AND route_provider = 'nous';

UPDATE roadmap.model_routes
SET cost_per_million_input  = 0.200000,
    cost_per_million_output = 0.800000
WHERE model_name = 'xiaomi/mimo-v2-omni'
  AND route_provider = 'nous';

-- ── 6. Disable routes that are not part of the current xiaomi-first policy
--    (These can be re-enabled via model_routes.is_enabled when needed.)
UPDATE roadmap.model_routes
SET is_enabled = false
WHERE is_enabled = true
  AND NOT (model_name LIKE 'xiaomi/mimo-v2%');

-- ── 7. Grants ───────────────────────────────────────────────────────────────
GRANT SELECT ON roadmap.model_routes TO roadmap_agent;

COMMIT;
