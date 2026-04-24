-- Migration 054: Fix copilot model routes to use valid model names
-- 
-- The copilot CLI only accepts specific model IDs via --model flag.
-- Models like gpt-4.1-nano, gpt-4.1-mini, claude-sonnet-4-6, claude-opus-4-6,
-- o3, o4-mini, and test-model are not accepted by the copilot CLI binary.
-- gpt-4.1 and gpt-4o are valid and should be the primary routes.
--
-- Applied live: 2026-04-24

-- Disable model names not accepted by the copilot CLI --model flag
UPDATE roadmap.model_routes
SET is_enabled = false
WHERE agent_cli = 'copilot'
  AND model_name IN (
    'gpt-4.1-nano', 'gpt-4.1-mini',
    'claude-sonnet-4-6', 'claude-opus-4-6',
    'gpt-4o-mini', 'o3', 'o4-mini', 'test-model'
  );

-- Promote gpt-4.1 to priority 1 (highest) for copilot routes
UPDATE roadmap.model_routes
SET priority = 1, is_enabled = true
WHERE agent_cli = 'copilot'
  AND model_name = 'gpt-4.1';
