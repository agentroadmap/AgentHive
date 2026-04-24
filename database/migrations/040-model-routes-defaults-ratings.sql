-- Migration 040: Model defaults, capabilities, objective ratings, and real costs
--
-- Goals:
--   1. Add is_default so each agent_provider has a DB-resolved default model.
--   2. Add capabilities[] and objective_rating for model selection.
--   3. Backfill real cache costs and ratings for all routes.

BEGIN;

-- 1. Schema additions
ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS capabilities TEXT[],
  ADD COLUMN IF NOT EXISTS objective_rating NUMERIC; -- LMSYS Elo-like scale

-- 2. Unique partial index: only one default per agent_provider
DROP INDEX IF EXISTS roadmap.model_routes_agent_provider_default_idx;
CREATE UNIQUE INDEX model_routes_agent_provider_default_idx
  ON roadmap.model_routes (agent_provider)
  WHERE is_default = true;

-- 3. Backfill capabilities (generic per model family)
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'claude-opus%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'claude-sonnet%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'claude-haiku%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'gpt-4o%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'gpt-4.1%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'gpt-5%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'o3%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'o4-mini%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'gemini-2.5-pro%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'gemini-2.0-flash%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['reasoning','coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'moonshotai/kimi-k2.6%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'xiaomi/mimo-v2-pro%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode','tts'] WHERE model_name LIKE 'xiaomi/mimo-v2-omni%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'xiaomi/mimo-v2.5%';
UPDATE roadmap.model_routes SET capabilities = ARRAY['coding','vision','tool_use','long_context','multilingual','json_mode'] WHERE model_name LIKE 'codex-mini%';

-- 4. Backfill objective ratings (approximate LMSYS Elo scale, 1200-1350)
UPDATE roadmap.model_routes SET objective_rating = 1325 WHERE model_name LIKE 'gpt-5.4%';
UPDATE roadmap.model_routes SET objective_rating = 1330 WHERE model_name LIKE 'o3%';
UPDATE roadmap.model_routes SET objective_rating = 1310 WHERE model_name LIKE 'gemini-2.5-pro%';
UPDATE roadmap.model_routes SET objective_rating = 1300 WHERE model_name LIKE 'claude-opus%';
UPDATE roadmap.model_routes SET objective_rating = 1295 WHERE model_name LIKE 'moonshotai/kimi-k2.6%';
UPDATE roadmap.model_routes SET objective_rating = 1290 WHERE model_name LIKE 'gpt-4.1' AND model_name NOT LIKE '%mini%' AND model_name NOT LIKE '%nano%';
UPDATE roadmap.model_routes SET objective_rating = 1285 WHERE model_name LIKE 'gpt-4o' AND model_name NOT LIKE '%mini%';
UPDATE roadmap.model_routes SET objective_rating = 1285 WHERE model_name LIKE 'claude-sonnet%';
UPDATE roadmap.model_routes SET objective_rating = 1280 WHERE model_name LIKE 'codex-mini%';
UPDATE roadmap.model_routes SET objective_rating = 1280 WHERE model_name LIKE 'o4-mini%';
UPDATE roadmap.model_routes SET objective_rating = 1270 WHERE model_name LIKE 'xiaomi/mimo-v2-pro%';
UPDATE roadmap.model_routes SET objective_rating = 1255 WHERE model_name LIKE 'gemini-2.0-flash%' AND model_name NOT LIKE '%lite%';
UPDATE roadmap.model_routes SET objective_rating = 1250 WHERE model_name LIKE 'xiaomi/mimo-v2-omni%';
UPDATE roadmap.model_routes SET objective_rating = 1245 WHERE model_name LIKE 'gemini-2.0-flash-lite%';
UPDATE roadmap.model_routes SET objective_rating = 1220 WHERE model_name LIKE 'claude-haiku%';
UPDATE roadmap.model_routes SET objective_rating = 1240 WHERE model_name LIKE 'gpt-4.1-mini%';
UPDATE roadmap.model_routes SET objective_rating = 1230 WHERE model_name LIKE 'gpt-4.1-nano%';
UPDATE roadmap.model_routes SET objective_rating = 1235 WHERE model_name LIKE 'gpt-4o-mini%';
UPDATE roadmap.model_routes SET objective_rating = 1200 WHERE model_name = 'test-model';

-- 5. Backfill missing cache costs for OpenAI routes (approximate: cache_write = 1.25x input, cache_read = 0.1x input)
UPDATE roadmap.model_routes
SET cost_per_million_cache_write = cost_per_million_input * 1.25,
    cost_per_million_cache_hit   = cost_per_million_input * 0.1
WHERE route_provider = 'openai'
  AND cost_per_million_cache_write IS NULL;

-- Google routes: approximate (cache_write = 1.0x input, cache_read = 0.25x input)
UPDATE roadmap.model_routes
SET cost_per_million_cache_write = cost_per_million_input * 1.0,
    cost_per_million_cache_hit   = cost_per_million_input * 0.25
WHERE route_provider = 'google'
  AND cost_per_million_cache_write IS NULL;

-- Nous routes: approximate (cache_write = 1.0x input, cache_read = 0.1x input)
UPDATE roadmap.model_routes
SET cost_per_million_cache_write = cost_per_million_input * 1.0,
    cost_per_million_cache_hit   = cost_per_million_input * 0.1
WHERE route_provider = 'nous'
  AND cost_per_million_cache_write IS NULL;

-- Xiaomi routes: zero cost (internal / covered)
UPDATE roadmap.model_routes
SET cost_per_million_cache_write = 0,
    cost_per_million_cache_hit   = 0
WHERE route_provider = 'xiaomi'
  AND cost_per_million_cache_write IS NULL;

-- GitHub routes: zero cost (Copilot subscription)
UPDATE roadmap.model_routes
SET cost_per_million_cache_write = 0,
    cost_per_million_cache_hit   = 0
WHERE route_provider = 'github'
  AND cost_per_million_cache_write IS NULL;

-- 6. Set is_default per agent_provider (cheapest enabled route wins)
UPDATE roadmap.model_routes SET is_default = false;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY agent_provider
           ORDER BY COALESCE(cost_per_million_input, 9999) ASC, priority ASC
         ) AS rn
  FROM roadmap.model_routes
  WHERE is_enabled = true
)
UPDATE roadmap.model_routes
SET is_default = true
FROM ranked
WHERE roadmap.model_routes.id = ranked.id
  AND ranked.rn = 1;

COMMIT;
