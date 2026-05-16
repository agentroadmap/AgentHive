-- Migration 152: align copilot route model_name with what the installed Copilot CLI accepts
--
-- Observed 2026-05-14: orchestrator's implicit-gate spawn fired
--   copilot -p ... --model claude-sonnet-4-6
-- which exited with:
--   Error: Model "claude-sonnet-4-6" from --model flag is not available.
--
-- Probed `copilot --model X -p ...` for every model name currently in
-- model_routes and additional candidates. Results for installed Copilot
-- CLI 1.0.48:
--   accepted: gpt-5.4, claude-sonnet-4.5, gpt-4.1
--   rejected: claude-opus-4-6, claude-sonnet-4-6, gpt-4o, claude-opus-4,
--             claude-3.5-sonnet, claude-opus-4.5, o3, o4-mini, gpt-4.1-mini
--
-- The dashed-version format (`claude-sonnet-4-6`) is correct for the
-- Anthropic /v1/messages API directly, but Copilot's gateway uses
-- dotted-version aliases (`claude-sonnet-4.5`). Silent drift since the
-- schema doesn't model CLI-specific aliasing.
--
-- Fix: register claude-sonnet-4.5 in model_metadata (required by the FK
-- on model_routes), update copilot route id=27 to use it, and disable
-- copilot routes whose model_name has no equivalent on Copilot 1.0.48.

-- ── Step 1: register claude-sonnet-4.5 in metadata ───────────────────────────

INSERT INTO roadmap.model_metadata (provider, model_name, capabilities)
VALUES ('github', 'claude-sonnet-4.5', '{"source":"migration_152"}'::jsonb)
ON CONFLICT (provider, model_name) DO NOTHING;

-- ── Step 2: rename copilot claude-sonnet route to the valid model name ───────

UPDATE roadmap.model_routes
SET model_name = 'claude-sonnet-4.5'
WHERE id = 27
  AND agent_cli = 'copilot'
  AND model_name = 'claude-sonnet-4-6';

-- ── Step 3: disable routes with no copilot 1.0.48 equivalent ─────────────────

UPDATE roadmap.model_routes
SET is_enabled = false,
    notes = COALESCE(notes, '') || ' (disabled 2026-05-14: no claude-opus model accepted by copilot 1.0.48 — migration 152)'
WHERE id = 26
  AND agent_cli = 'copilot'
  AND is_enabled = true;

UPDATE roadmap.model_routes
SET is_enabled = false,
    notes = COALESCE(notes, '') || ' (disabled 2026-05-14: gpt-4o not accepted by copilot 1.0.48 — use gpt-5.4 instead — migration 152)'
WHERE id = 32
  AND agent_cli = 'copilot'
  AND model_name = 'gpt-4o'
  AND is_enabled = true;

-- ── Step 4: defensive guard ──────────────────────────────────────────────────

DO $$
DECLARE
  v_bad_row roadmap.model_routes%ROWTYPE;
BEGIN
  FOR v_bad_row IN
    SELECT * FROM roadmap.model_routes
    WHERE is_enabled = true
      AND agent_cli = 'copilot'
      AND model_name NOT IN ('gpt-5.4', 'claude-sonnet-4.5', 'gpt-4.1')
  LOOP
    RAISE EXCEPTION 'Migration 152: enabled copilot route id=% has unsupported model_name=%. Accepted by Copilot 1.0.48: gpt-5.4, claude-sonnet-4.5, gpt-4.1.',
      v_bad_row.id, v_bad_row.model_name;
  END LOOP;
END$$;
