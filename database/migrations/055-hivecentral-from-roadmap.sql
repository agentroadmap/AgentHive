-- Migration 055: Populate hivecentral.* from roadmap.model_routes + roadmap.host_model_policy
--
-- Prerequisites: 004-model.sql, 005-dispatch-stub.sql applied first.
-- Idempotency:   All inserts use ON CONFLICT DO NOTHING; safe to re-run.
-- Orphan gate:   Emits WARNING for routes missing pricing; raises EXCEPTION if any
--                (host, route) pair is unresolvable after policy expansion.
--
-- Steps:
--   1. Import distinct models from roadmap.model_routes → hivecentral.model
--   2. Import routes from roadmap.model_routes → hivecentral.model_route
--   3. Expand roadmap.host_model_policy TEXT[] arrays → per-row hivecentral.host_model_policy
--   4. Orphan check: assert all (host, route) combinations have a policy row

BEGIN;

-- ── Step 1: Import models from roadmap.model_routes ──────────────────────────
-- Derives provider and family from model_name prefix patterns.
-- capability mapping: old underscore-based vocab → new hyphen-based vocab (only exact matches kept).

INSERT INTO hivecentral.model (model_name, provider, family, capabilities)
SELECT DISTINCT ON (mr.model_name)
    mr.model_name,
    CASE
        WHEN mr.model_name LIKE 'claude-%'       THEN 'anthropic'
        WHEN mr.model_name LIKE 'gpt-%'          THEN 'openai'
        WHEN mr.model_name LIKE 'o3%'            THEN 'openai'
        WHEN mr.model_name LIKE 'o4-%'           THEN 'openai'
        WHEN mr.model_name LIKE 'codex-%'        THEN 'openai'
        WHEN mr.model_name LIKE 'gemini-%'       THEN 'google'
        WHEN mr.model_name LIKE 'xiaomi/%'       THEN 'xiaomi'
        WHEN mr.model_name LIKE 'moonshotai/%'   THEN 'moonshot'
        ELSE mr.route_provider
    END AS provider,
    CASE
        WHEN mr.model_name LIKE 'claude-%'       THEN 'claude'
        WHEN mr.model_name LIKE 'gpt-%'          THEN 'gpt'
        WHEN mr.model_name LIKE 'gemini-%'       THEN 'gemini'
        WHEN mr.model_name LIKE 'xiaomi/mimo-%'  THEN 'mimo'
        ELSE NULL
    END AS family,
    -- Only retain capability tokens that belong to the new hyphen vocabulary
    COALESCE(
        ARRAY(
            SELECT DISTINCT tok
            FROM   unnest(mr.capabilities) tok
            WHERE  tok IN (
                'long-context', 'tool-use', 'vision', 'code-review',
                'structured-output', 'reasoning', 'streaming', 'cache-aware'
            )
        ),
        '{}'::TEXT[]
    ) AS capabilities
FROM roadmap.model_routes mr
WHERE mr.model_name IS NOT NULL
ORDER BY mr.model_name
ON CONFLICT (model_name) DO NOTHING;

-- ── Step 2: Import routes from roadmap.model_routes ──────────────────────────
-- route_name derived from: <sanitized_model_name>-via-<route_provider>-<agent_provider>
-- Only routes with at least one pricing column are imported (others emit a WARNING in step 2b).

INSERT INTO hivecentral.model_route (
    route_name,
    model_id,
    route_provider,
    api_spec,
    agent_cli,
    cli_path,
    priority,
    is_enabled,
    is_default,
    rate_limit_rpm,
    rate_limit_tpd,
    cost_per_1k_input,
    cost_per_1k_output,
    cost_per_1m_input,
    cost_per_1m_output,
    cost_per_1m_cache_write,
    cost_per_1m_cache_hit,
    api_key_env,
    api_key_fallback_env,
    base_url_env,
    spawn_toolsets,
    objective_rating
)
SELECT
    LOWER(REGEXP_REPLACE(
        mr.model_name || '-via-' || mr.route_provider || '-' || COALESCE(mr.agent_provider, 'default'),
        '[^a-z0-9]+', '-', 'g'
    ))                                                       AS route_name,
    hm.id                                                    AS model_id,
    mr.route_provider,
    COALESCE(mr.api_spec, mr.route_provider)                 AS api_spec,
    mr.agent_cli,
    mr.cli_path,
    COALESCE(mr.priority, 5)::SMALLINT                       AS priority,
    COALESCE(mr.is_enabled, false)                           AS is_enabled,
    COALESCE(mr.is_default, false)                           AS is_default,
    mr.rate_limit_rpm,
    mr.rate_limit_tpd,
    mr.cost_per_1k_input,
    mr.cost_per_1k_output,
    mr.cost_per_million_input                                AS cost_per_1m_input,
    mr.cost_per_million_output                               AS cost_per_1m_output,
    mr.cost_per_million_cache_write                          AS cost_per_1m_cache_write,
    mr.cost_per_million_cache_hit                            AS cost_per_1m_cache_hit,
    mr.api_key_env,
    mr.api_key_fallback_env,
    mr.base_url_env,
    mr.spawn_toolsets,
    mr.objective_rating
FROM  roadmap.model_routes mr
JOIN  hivecentral.model    hm ON hm.model_name = mr.model_name
WHERE mr.cost_per_1k_input       IS NOT NULL
   OR mr.cost_per_million_input  IS NOT NULL
ON CONFLICT (route_name) DO NOTHING;

-- Step 2b: Warn (not fail) on routes skipped due to missing pricing
DO $$
DECLARE
    orphan_count INT;
BEGIN
    SELECT COUNT(*) INTO orphan_count
    FROM  roadmap.model_routes
    WHERE cost_per_1k_input      IS NULL
      AND cost_per_million_input IS NULL;

    IF orphan_count > 0 THEN
        RAISE WARNING
            'Migration 055: % roadmap.model_routes rows skipped — no pricing data. '
            'Backfill pricing or disable these routes before switching dispatch to hivecentral.',
            orphan_count;
    END IF;
END $$;

-- ── Step 3: Expand roadmap.host_model_policy arrays → per-row hivecentral policy ──
-- v1 schema: host_name TEXT PK, allowed_providers TEXT[], forbidden_providers TEXT[]
-- v2 schema: one explicit row per (host, route_id) with is_allowed + deny_reason
--
-- Resolution rules (mirror roadmap.fn_check_spawn_policy logic):
--   1. route_provider in forbidden_providers → is_allowed=false
--   2. allowed_providers is empty array      → is_allowed=true  (legacy open policy)
--   3. route_provider in allowed_providers   → is_allowed=true
--   4. otherwise                             → is_allowed=false

INSERT INTO hivecentral.host_model_policy (host, route_id, is_allowed, deny_reason)
SELECT
    p.host_name                                              AS host,
    mr.id                                                    AS route_id,
    CASE
        WHEN mr.route_provider = ANY(p.forbidden_providers)
            THEN false
        WHEN cardinality(p.allowed_providers) = 0
            THEN true
        WHEN mr.route_provider = ANY(p.allowed_providers)
            THEN true
        ELSE false
    END                                                      AS is_allowed,
    CASE
        WHEN mr.route_provider = ANY(p.forbidden_providers)
            THEN 'v1 migration: route_provider in forbidden_providers'
        WHEN cardinality(p.allowed_providers) > 0
             AND NOT (mr.route_provider = ANY(p.allowed_providers))
            THEN 'v1 migration: route_provider not in allowed_providers list'
        ELSE NULL
    END                                                      AS deny_reason
FROM  roadmap.host_model_policy p
CROSS JOIN hivecentral.model_route mr
ON CONFLICT (host, route_id) DO NOTHING;

-- ── Step 4: Orphan gate — abort if any (host, route) pair is unresolved ───────
DO $$
DECLARE
    missing_count INT;
BEGIN
    SELECT COUNT(*) INTO missing_count
    FROM  hivecentral.model_route mr
    CROSS JOIN (SELECT DISTINCT host_name FROM roadmap.host_model_policy) hosts
    WHERE NOT EXISTS (
        SELECT 1
        FROM   hivecentral.host_model_policy hp
        WHERE  hp.route_id = mr.id
          AND  hp.host     = hosts.host_name
    );

    IF missing_count > 0 THEN
        RAISE EXCEPTION
            'Migration 055 orphan gate: % (host, route) combinations have no policy row. '
            'Review migration logic or seed missing rows before continuing.',
            missing_count;
    END IF;
END $$;

COMMIT;
