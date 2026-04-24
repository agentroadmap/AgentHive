-- P245: Host-level spawn policy
--
-- Problem: Hermes orchestrator was resolving to Anthropic routes via the
-- claude-prefix provider fallback, burning Anthropic credit while the
-- main CLI is supposed to be strictly xiaomi/mimo-v2-omni.
--
-- Solution: Add a host-level gate. The spawner looks up the current host
-- in roadmap.host_model_policy and checks the RESOLVED route_provider
-- (not the raw model name). Policy violations escalate to
-- roadmap.escalation_log with severity=high and the CLI is never spawned.
--
-- Note (design correction from P245 proposal body): the original design
-- used split_part(p_model,'/',1) which breaks for dotted model names like
-- 'claude-sonnet-4-6' (no slash -> always passes the forbidden check).
-- Using route_provider from the already-resolved ModelRoute is correct
-- and avoids rebuilding route lookup in SQL.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.host_model_policy (
    host_name         TEXT PRIMARY KEY,
    allowed_providers TEXT[] NOT NULL,
    forbidden_providers TEXT[] NOT NULL DEFAULT '{}',
    default_model     TEXT   NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  roadmap.host_model_policy IS
    'Host-level allow/forbid list for route_provider. Checked in agent-spawner before CLI launch.';
COMMENT ON COLUMN roadmap.host_model_policy.allowed_providers IS
    'Allowed route_provider values (e.g. anthropic, nous, xiaomi, openai, google). Empty array = any non-forbidden allowed.';
COMMENT ON COLUMN roadmap.host_model_policy.forbidden_providers IS
    'Route_provider values that MUST never run on this host. Takes precedence over allowed_providers.';

INSERT INTO roadmap.host_model_policy(host_name, allowed_providers, forbidden_providers, default_model) VALUES
    ('bot',        ARRAY[]::TEXT[],                          ARRAY[]::TEXT[], 'gpt-5.4'),
    ('hermes',     ARRAY['nous','xiaomi'],                   ARRAY['anthropic'], 'xiaomi/mimo-v2-omni'),
    ('gary-main',  ARRAY['nous','xiaomi'],                   ARRAY['anthropic'], 'xiaomi/mimo-v2-omni'),
    ('claude-box', ARRAY['anthropic','nous','xiaomi','openai','google','github'], ARRAY[]::TEXT[], 'claude-sonnet-4-6')
ON CONFLICT (host_name) DO UPDATE
    SET allowed_providers   = EXCLUDED.allowed_providers,
        forbidden_providers = EXCLUDED.forbidden_providers,
        default_model       = EXCLUDED.default_model,
        updated_at          = now();

CREATE OR REPLACE FUNCTION roadmap.fn_check_spawn_policy(
    p_host TEXT,
    p_route_provider TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN p.host_name IS NULL THEN TRUE                                   -- unknown host: legacy permit
        WHEN p_route_provider = ANY(p.forbidden_providers) THEN FALSE         -- explicit forbid wins
        WHEN cardinality(p.allowed_providers) = 0 THEN TRUE                   -- empty allow-list = permit
        ELSE p_route_provider = ANY(p.allowed_providers)
    END
    FROM roadmap.host_model_policy p
    WHERE p.host_name = p_host
    UNION ALL
    SELECT TRUE
    WHERE NOT EXISTS (SELECT 1 FROM roadmap.host_model_policy WHERE host_name = p_host)
    LIMIT 1;
$$;

COMMENT ON FUNCTION roadmap.fn_check_spawn_policy(TEXT, TEXT) IS
    'Returns TRUE if the given route_provider is allowed to spawn on the given host. Unknown hosts are permitted (legacy fallback).';

-- Extend escalation_log.obstacle_type to include SPAWN_POLICY_VIOLATION.
ALTER TABLE roadmap.escalation_log
    DROP CONSTRAINT IF EXISTS escalation_log_obstacle_type_check;
ALTER TABLE roadmap.escalation_log
    ADD CONSTRAINT escalation_log_obstacle_type_check
    CHECK (obstacle_type = ANY (ARRAY[
        'BUDGET_EXHAUSTED',
        'LOOP_DETECTED',
        'CYCLE_DETECTED',
        'AGENT_DEAD',
        'PIPELINE_BLOCKED',
        'AC_GATE_FAILED',
        'DEPENDENCY_UNRESOLVED',
        'SPAWN_POLICY_VIOLATION'
    ]));

COMMIT;
