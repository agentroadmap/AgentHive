-- P1129 (AC-13 / AC-22, AC-VOCAB): Backfill NULL preferred_provider on agencies.
--
-- CONTEXT
--   Self-service agency registration (P1129 Phase A) now persists
--   preferred_provider, but ~177 pre-existing agency rows predate that column
--   and carry preferred_provider IS NULL. Routing/match code treats NULL as
--   "no canonical provider", so these agencies are invisible to provider-aware
--   selection. This migration assigns each a canonical value from the agency
--   vocabulary {claude, codex, gemini, copilot, xiaomi, antigravity}.
--
-- MEASURED SCOPE (live agenthive, 2026-06-14 — NOT the 6/152 the AC text guessed)
--   SELECT count(*) FROM roadmap_workforce.agent_registry
--     WHERE agent_type='agency' AND preferred_provider IS NULL;   -- = 177
--   Of those 177: agent_cli IS NULL for all 177, current_route_id IS NULL for
--   all 177. The ONLY surviving provider signal is the identity prefix.
--   Prefix breakdown:
--     agency-agents/*        164   (persona/template rows — no provider signal)
--     claude/agency-bot/*      7
--     liaison:test/agency-*    2
--     gemini-bot-*             1
--     codex-agency-*           1
--     hermes/agency-*          1
--     agenthive/agency-*       1
--
-- MAPPING RULE (derived from existing signal, not a blind default)
--   1. If the identity prefix is a recognised provider token, use it:
--        claude/*  -> 'claude'      codex*    -> 'codex'
--        gemini*   -> 'gemini'      copilot*  -> 'copilot'
--        xiaomi*   -> 'xiaomi'
--      'hermes' is a Claude-backed orchestration persona on this fleet, so
--      hermes/* -> 'claude'.
--   2. Everything else (the 164 'agency-agents/*' persona templates, plus the
--      'liaison:test/*' and 'agenthive/*' rows) has NO provider signal. These
--      are template definitions, not live workers; they are assigned the
--      canonical default brain 'claude' so routing has a deterministic value.
--      *** OPERATOR REVIEW FLAG: these 167 rows are a documented heuristic
--      default, not an observed provider. When a template is instantiated as a
--      real worker via register_model/agent_pg_register the live value wins
--      (Phase A COALESCE upsert), correcting any wrong default. ***
--
-- VOCABULARY NOTE
--   preferred_provider is the AGENCY/CLI vocabulary {claude,codex,gemini,
--   copilot,xiaomi,antigravity}, NOT roadmap.model_metadata.provider
--   {anthropic,google,openai,...}. The FK agent_registry_model_provider_fkey
--   (preferred_provider, preferred_model) -> model_metadata(provider,model_name)
--   only fires when preferred_model IS NOT NULL. All 177 target rows have
--   preferred_model IS NULL, so this backfill is FK-safe for every value.
--
-- IDEMPOTENT: guarded by `preferred_provider IS NULL`; safe to re-run (a second
--   run matches 0 rows). No CHECK constraint exists on preferred_provider.
--
-- NOT APPLIED TO LIVE BY THIS PROPOSAL — written + linted only.

UPDATE roadmap_workforce.agent_registry
SET preferred_provider = CASE
        WHEN agent_identity LIKE 'claude/%'  THEN 'claude'
        WHEN agent_identity LIKE 'codex-%'   THEN 'codex'
        WHEN agent_identity LIKE 'codex/%'   THEN 'codex'
        WHEN agent_identity LIKE 'gemini-%'  THEN 'gemini'
        WHEN agent_identity LIKE 'gemini/%'  THEN 'gemini'
        WHEN agent_identity LIKE 'copilot-%' THEN 'copilot'
        WHEN agent_identity LIKE 'copilot/%' THEN 'copilot'
        WHEN agent_identity LIKE 'xiaomi-%'  THEN 'xiaomi'
        WHEN agent_identity LIKE 'xiaomi/%'  THEN 'xiaomi'
        WHEN agent_identity LIKE 'hermes/%'  THEN 'claude'
        -- Default: persona templates + signal-less rows -> canonical brain.
        ELSE 'claude'
    END,
    updated_at = now()
WHERE agent_type = 'agency'
  AND preferred_provider IS NULL;
