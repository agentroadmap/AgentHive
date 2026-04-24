-- Relax host_model_policy for 'bot' to match current provider stack.
--
-- Context: Migration 004 seeded 'bot' with allowed_providers = {nous, xiaomi}
-- to mirror the hermes/gary-main posture when this machine ran Hermes.
-- The host has since transitioned to GitHub Copilot; all enabled model_routes
-- now use route_provider IN ('openai', 'github').  The stale {nous, xiaomi}
-- allowlist blocks every dispatch the orchestrator and gate-pipeline attempt.
--
-- Fix: clear allowed_providers (empty array = permit all non-forbidden) and
-- retain only 'anthropic' in forbidden_providers.  This lets any future
-- provider (google, nous, xiaomi, etc.) be added to model_routes without
-- requiring another policy migration.

BEGIN;

UPDATE roadmap.host_model_policy
SET
    allowed_providers   = ARRAY[]::text[],   -- empty = permit all non-forbidden
    forbidden_providers = ARRAY['anthropic'], -- still block direct Anthropic spend
    default_model       = NULL,              -- no longer nous-specific default
    updated_at          = now()
WHERE host_name = 'bot';

-- Apply the same relaxation to gary-main and claude-box which share the same
-- provider stack.  hermes is intentionally left as {nous,xiaomi} because that
-- machine still runs the Hermes stack.
UPDATE roadmap.host_model_policy
SET
    allowed_providers   = ARRAY[]::text[],
    forbidden_providers = ARRAY['anthropic'],
    default_model       = NULL,
    updated_at          = now()
WHERE host_name IN ('gary-main', 'claude-box');

COMMIT;
