-- Migration 149: fix model_routes id=5 agent_cli mismatch
--
-- Problem: route id=5 (gemini-2.0-flash, agent_provider='gemini') had
-- agent_cli='hermes'. The spawner uses agent_cli to pick the argv builder,
-- so spawnAgent called buildHermesArgs() which produced
--   gemini chat -q <task> -m <model> --provider <p> --yolo -Q --toolsets ...
-- The real Gemini CLI (gemini --help) does not accept any of `chat`, `-q`,
-- `--provider`, `-Q`, or `--toolsets`, so every spawn died with
--   "Unknown arguments: q, provider, Q, toolsets"
-- The 24-hour audit before this fix counted 93 such failures (mostly george).
--
-- Fix: agent_cli should equal the actual binary family. For agent_provider
-- 'gemini' the right builder is buildGeminiArgs() which emits
--   gemini --model <model> --prompt <task>
-- which the installed gemini binary accepts.

UPDATE roadmap.model_routes
SET agent_cli = 'gemini'
WHERE id = 5
  AND agent_provider = 'gemini'
  AND agent_cli = 'hermes';

-- Defensive guard: future Gemini routes must also use the gemini CLI builder,
-- not the hermes one. Hermes is the legacy AgentHive native framework binary
-- that takes a different flag set entirely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM roadmap.model_routes
    WHERE is_enabled = true
      AND agent_provider = 'gemini'
      AND agent_cli != 'gemini'
  ) THEN
    RAISE EXCEPTION 'Migration 149: gemini-provider routes must have agent_cli=''gemini''. Found mismatched rows.';
  END IF;
END$$;
