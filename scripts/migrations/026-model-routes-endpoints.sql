-- Migration 026: Model Routes — API Endpoints and Spec
--
-- Adds two columns to model_routes:
--   base_url   TEXT  — provider API root (e.g. https://api.anthropic.com)
--   api_spec   TEXT  — wire format: 'anthropic' | 'openai' | 'google'
--
-- With these columns the spawner can:
--   1. Build the correct CLI args from route metadata alone (not from worktree name)
--   2. Support global escalation — e.g. an openclaw worktree escalating to
--      claude-opus-4-6 by switching to the anthropic route + spec
--   3. Allow mimo-v2-pro to be called via either OpenAI or Anthropic spec
--      depending on which endpoint is preferred
--
-- Known base URLs and specs:
--   anthropic → https://api.anthropic.com           anthropic spec
--   openai    → https://api.openai.com/v1            openai spec
--   google    → https://generativelanguage.googleapis.com/v1beta  google spec
--   nous      → https://inference-api.nousresearch.com/v1          openai spec
--   xiaomi    → https://api.xiaomi.com/v1  (OpenAI-compatible)     openai spec
--              also supports anthropic-compatible endpoint at /anthropic/v1

BEGIN;

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS base_url  TEXT,
  ADD COLUMN IF NOT EXISTS api_spec  TEXT;   -- 'anthropic' | 'openai' | 'google'

COMMENT ON COLUMN roadmap.model_routes.base_url IS
  'API root URL for this route. Used by the spawner to set OPENAI_BASE_URL or equivalent.';
COMMENT ON COLUMN roadmap.model_routes.api_spec IS
  'Wire protocol: anthropic | openai | google. Determines which CLI/SDK the spawner uses.';

-- ── Anthropic routes ───────────────────────────────────────────────────────
UPDATE roadmap.model_routes
SET base_url = 'https://api.anthropic.com',
    api_spec = 'anthropic'
WHERE route_provider = 'anthropic';

-- ── OpenAI routes ──────────────────────────────────────────────────────────
UPDATE roadmap.model_routes
SET base_url = 'https://api.openai.com/v1',
    api_spec = 'openai'
WHERE route_provider = 'openai';

-- ── Google routes ──────────────────────────────────────────────────────────
UPDATE roadmap.model_routes
SET base_url = 'https://generativelanguage.googleapis.com/v1beta',
    api_spec = 'google'
WHERE route_provider = 'google';

-- ── Nous routes (OpenAI-compatible) ───────────────────────────────────────
UPDATE roadmap.model_routes
SET base_url = 'https://inference-api.nousresearch.com/v1',
    api_spec = 'openai'
WHERE route_provider = 'nous';

-- ── Xiaomi routes — two specs, same model ─────────────────────────────────
-- Current seeded routes use openai spec (token plan via claude agent_provider).
-- Add a second anthropic-spec route so mimo can be called with Anthropic SDK too.
UPDATE roadmap.model_routes
SET base_url = 'https://api.xiaomi.com/v1',
    api_spec = 'openai'
WHERE route_provider = 'xiaomi';

-- Anthropic-compatible endpoint for mimo (separate routes, disabled by default
-- until Xiaomi confirms anthropic-spec support)
INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('xiaomi/mimo-v2-pro',  'xiaomi', 'claude', 0, 0,
   'token_plan', 2, false,
   'https://api.xiaomi.com/anthropic/v1', 'anthropic',
   'Xiaomi anthropic-spec endpoint — enable once confirmed'),
  ('xiaomi/mimo-v2-omni', 'xiaomi', 'claude', 0, 0,
   'token_plan', 2, false,
   'https://api.xiaomi.com/anthropic/v1', 'anthropic',
   'Xiaomi anthropic-spec endpoint — enable once confirmed')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

-- ── Cross-provider escalation routes ──────────────────────────────────────
-- Allow openclaw worktrees to escalate to claude-opus-4-6 via anthropic route.
-- is_enabled=false by default; enable when cross-provider escalation is desired.
INSERT INTO roadmap.model_routes
  (model_name, route_provider, agent_provider, cost_per_1k_input, cost_per_1k_output,
   plan_type, priority, is_enabled, base_url, api_spec, notes)
VALUES
  ('claude-opus-4-6',   'anthropic', 'openclaw', 0.015000, 0.075000,
   'api_key', 99, false,
   'https://api.anthropic.com', 'anthropic',
   'Cross-provider escalation: openclaw → opus. Enable for high-severity escalation.'),
  ('claude-sonnet-4-6', 'anthropic', 'openclaw', 0.003000, 0.015000,
   'api_key', 98, false,
   'https://api.anthropic.com', 'anthropic',
   'Cross-provider escalation: openclaw → sonnet. Enable for high-severity escalation.')
ON CONFLICT (model_name, route_provider, agent_provider) DO NOTHING;

COMMIT;
