-- P245 follow-up: default-deny anthropic on unknown hosts
--
-- Problem: fn_check_spawn_policy returned TRUE for any host not listed
-- in host_model_policy (legacy fallback). On machines where hostname()
-- doesn't match a seeded policy row (e.g. the CLI spawns outside the
-- systemd unit, so AGENTHIVE_HOST isn't set and hostname() resolves to
-- something like 'bot'), this opened a path for anthropic routes to
-- spawn on a host that was never intended to burn Anthropic credit.
--
-- Solution: make the fallback safe-by-default. Unknown hosts now deny
-- 'anthropic' explicitly; any other provider still passes, preserving
-- the legacy permit for xiaomi/nous/openai/google/github.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_check_spawn_policy(
    p_host TEXT,
    p_route_provider TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN p.host_name IS NULL THEN p_route_provider <> 'anthropic'  -- unknown host: deny anthropic, permit others
        WHEN p_route_provider = ANY(p.forbidden_providers) THEN FALSE   -- explicit forbid wins
        WHEN cardinality(p.allowed_providers) = 0 THEN TRUE             -- empty allow-list = permit
        ELSE p_route_provider = ANY(p.allowed_providers)
    END
    FROM roadmap.host_model_policy p
    WHERE p.host_name = p_host
    UNION ALL
    SELECT p_route_provider <> 'anthropic'
    WHERE NOT EXISTS (SELECT 1 FROM roadmap.host_model_policy WHERE host_name = p_host)
    LIMIT 1;
$$;

COMMENT ON FUNCTION roadmap.fn_check_spawn_policy(TEXT, TEXT) IS
    'Returns TRUE if the given route_provider is allowed to spawn on the given host. Unknown hosts deny anthropic (safe fallback) but permit other providers.';

-- Seed 'bot' explicitly as the shared operator host. It may launch any
-- route_provider because the CLI/worktree identity, not the physical host,
-- is what determines which auth/config path the child process uses.
INSERT INTO roadmap.host_model_policy(host_name, allowed_providers, forbidden_providers, default_model) VALUES
    ('bot', ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'gpt-5.4')
ON CONFLICT (host_name) DO UPDATE
    SET allowed_providers   = EXCLUDED.allowed_providers,
        forbidden_providers = EXCLUDED.forbidden_providers,
        default_model       = EXCLUDED.default_model,
        updated_at          = now();

COMMIT;
