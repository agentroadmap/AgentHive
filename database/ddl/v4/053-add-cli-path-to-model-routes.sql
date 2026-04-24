-- Migration 053: Add cli_path column to model_routes
--
-- Stores the full filesystem path to the CLI binary for each route.
-- NULL = rely on system PATH (for CLIs installed system-wide).
-- Non-NULL = use this exact path, so agents can live anywhere (different users,
-- different machines) without hardcoding paths in spawner code or service units.
--
-- Eliminates the last hardcoded path from buildHermesArgs (/home/xiaomi/.local/bin/hermes)
-- and makes copilot, claude, codex, gemini equally configurable.
--
-- Applied live before this file was created; kept here as the schema record.

ALTER TABLE roadmap.model_routes
  ADD COLUMN IF NOT EXISTS cli_path text;

COMMENT ON COLUMN roadmap.model_routes.cli_path IS
  'Full filesystem path to the CLI binary. NULL = rely on system PATH. '
  'Set this to avoid hardcoding paths in service units or spawner code. '
  'Example: /home/gary/.local/bin/copilot, /home/xiaomi/.local/bin/hermes';

-- Seed known paths (idempotent)
UPDATE roadmap.model_routes SET cli_path = '/home/gary/.local/bin/copilot'
  WHERE agent_cli = 'copilot' AND cli_path IS NULL;

UPDATE roadmap.model_routes SET cli_path = '/home/xiaomi/.local/bin/hermes'
  WHERE agent_cli = 'hermes' AND cli_path IS NULL;
