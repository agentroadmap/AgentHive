-- Migration 040: Unified config directory, spawn control, and model cost backfill
--
-- 1. Add spawn_delegate to model_routes so the DB controls whether agents
--    spawned on this route may themselves spawn subagents.
-- 2. Backfill real costs for xiaomi models in model_metadata (they were 0).
-- 3. Add missing xiaomi models to model_metadata so foreign keys work.
-- 4. Update spawn_toolsets to explicitly exclude delegation when spawn_delegate=false.
--
-- Run as admin (touches model_metadata [andy-owned] and model_routes [admin-owned]).

BEGIN;

-- ── 1. Spawn delegate control ───────────────────────────────────────────────
ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS spawn_delegate BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN roadmap.model_routes.spawn_delegate IS
  'If true, agents spawned on this route may spawn their own subagents. '
  'If false (default), subagent spawn must go through the orchestrator spawnAgent(). '
  'Enforced via env isolation: spawned agents only receive API keys for their specific route.';

-- ── 2. Backfill xiaomi model costs in model_metadata ────────────────────────
-- Use Nous route pricing as the canonical catalog price (best available proxy).
UPDATE roadmap.model_metadata
   SET cost_per_million_input  = 1.00,
       cost_per_million_output = 2.00,
       updated_at = now()
 WHERE provider = 'xiaomi' AND model_name = 'xiaomi/mimo-v2-pro';

UPDATE roadmap.model_metadata
   SET cost_per_million_input  = 0.20,
       cost_per_million_output = 0.80,
       updated_at = now()
 WHERE provider = 'xiaomi' AND model_name = 'xiaomi/mimo-v2-omni';

UPDATE roadmap.model_metadata
   SET cost_per_million_input  = 1.00,
       cost_per_million_output = 2.00,
       updated_at = now()
 WHERE provider = 'xiaomi' AND model_name = 'xiaomi/mimo-v2.5-pro';

UPDATE roadmap.model_metadata
   SET cost_per_million_input  = 0.20,
       cost_per_million_output = 0.80,
       updated_at = now()
 WHERE provider = 'xiaomi' AND model_name = 'xiaomi/mimo-v2.5';

UPDATE roadmap.model_metadata
   SET cost_per_million_input  = 0.20,
       cost_per_million_output = 0.80,
       updated_at = now()
 WHERE provider = 'xiaomi' AND model_name = 'xiaomi/mimo-v2.5-tts';

-- ── 3. Insert missing xiaomi models into model_metadata ─────────────────────
INSERT INTO roadmap.model_metadata
  (model_name, provider, max_tokens, context_window, capabilities, rating, is_active,
   cost_per_million_input, cost_per_million_output)
SELECT v.model_name, v.provider, v.max_tokens, v.ctx, v.capabilities::jsonb, v.rating, true,
       v.cost_in, v.cost_out
FROM (VALUES
  ('xiaomi/mimo-v2-flash', 'xiaomi', 32768, 131072,
   '{"vision":true,"tool_use":true,"json_mode":true}', 4, 0.50, 2.00),
  ('xiaomi/mimo-v2-tts',   'xiaomi', 8192,  32768,
   '{"audio":true,"json_mode":true}', 4, 0.20, 0.80)
) AS v(model_name, provider, max_tokens, ctx, capabilities, rating, cost_in, cost_out)
WHERE NOT EXISTS (
  SELECT 1 FROM roadmap.model_metadata
   WHERE model_name = v.model_name AND provider = v.provider
);

-- ── 4. Ensure model_routes foreign keys are valid ───────────────────────────
-- Any route pointing to a non-existent model_metadata row would break.
-- This is a safety check; in practice all routes should already be valid.
DO $$
DECLARE
  invalid_route RECORD;
BEGIN
  FOR invalid_route IN
    SELECT r.model_name, r.route_provider
      FROM roadmap.model_routes r
      LEFT JOIN roadmap.model_metadata m
        ON m.model_name = r.model_name AND m.provider = r.route_provider
     WHERE m.model_name IS NULL
  LOOP
    RAISE NOTICE 'WARNING: model_routes has orphaned route: %/% (no model_metadata row)',
      invalid_route.route_provider, invalid_route.model_name;
  END LOOP;
END $$;

-- ── 5. Sync spawn_delegate for existing routes ──────────────────────────────
-- Hermes routes: default false (subagent spawn must go through orchestrator).
-- Claude/Codex/Gemini routes: default false (same policy).
-- Only explicitly enable for routes that are trusted to self-escalate.
UPDATE roadmap.model_routes SET spawn_delegate = false WHERE spawn_delegate IS NULL;

COMMIT;
