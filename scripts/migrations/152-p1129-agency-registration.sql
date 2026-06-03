-- Migration 152: P1129 — Self-service agency registration via MCP
--
-- Adds three new columns to agent_registry so agencies can self-describe
-- their execution environment when calling mcp_agent register:
--
--   display_name   TEXT  — human-friendly label (e.g. "George Gemini Agency")
--   host_affinity  TEXT  — preferred execution host (e.g. "bot", "codex-host")
--   agent_cli      TEXT  — CLI executable name (e.g. "claude", "codex", "gemini")
--
-- Also reconciles legacy preferred_provider vocabulary for agency rows:
--   'openai'  → 'codex'
--   'google'  → 'gemini'
--
-- All DDL is idempotent (IF NOT EXISTS guards).

BEGIN;

-- ── 1. New columns on agent_registry ─────────────────────────────────────────

ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS display_name   TEXT,
  ADD COLUMN IF NOT EXISTS host_affinity  TEXT,
  ADD COLUMN IF NOT EXISTS agent_cli      TEXT;

COMMENT ON COLUMN roadmap_workforce.agent_registry.display_name IS
  'Human-friendly label for the agent/agency (e.g. "George Gemini Agency"). '
  'Set by mcp_agent register; backfilled from agent_identity if NULL.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.host_affinity IS
  'Preferred execution host for this agency (e.g. "bot", "codex-host"). '
  'Orchestrator uses this as a soft placement hint, not a hard constraint.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.agent_cli IS
  'CLI executable name used to spawn child agents for this agency '
  '(e.g. "claude", "codex", "gemini"). Stored in agent_registry so the '
  'orchestrator can use it without a round-trip to model_routes.';

-- ── 2. Vocabulary migration: legacy preferred_provider values ─────────────────
-- Agency rows with provider='openai' were Codex agencies pre-rename.
-- Agency rows with provider='google' were Gemini agencies pre-rename.
-- Workers inherit from their parent agency; update agency rows only (agency_id IS NULL).

UPDATE roadmap_workforce.agent_registry
  SET preferred_provider = 'codex'
  WHERE preferred_provider = 'openai'
    AND agency_id IS NULL;

UPDATE roadmap_workforce.agent_registry
  SET preferred_provider = 'gemini'
  WHERE preferred_provider = 'google'
    AND agency_id IS NULL;

-- ── 3. Index on host_affinity for dispatcher queries ──────────────────────────

CREATE INDEX IF NOT EXISTS idx_agent_registry_host_affinity
  ON roadmap_workforce.agent_registry (host_affinity)
  WHERE host_affinity IS NOT NULL;

COMMIT;
