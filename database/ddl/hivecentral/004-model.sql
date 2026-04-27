-- P595: hivecentral model schema
-- Tables : model_capability, model, model_route, host_model_policy
-- Views  : v_active_routes, v_route_policy
-- Seeds  : 8-entry capability vocabulary + Claude opus/sonnet/haiku routes
-- Dep    : none (standalone schema; migration from roadmap.* is in 055-hivecentral-from-roadmap.sql)

BEGIN;

-- ── Schema ────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS hivecentral;

-- ── model_capability — controlled vocabulary (8 entries) ─────────────────────

CREATE TABLE IF NOT EXISTS hivecentral.model_capability (
    id          SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT         NOT NULL UNIQUE,
    description TEXT         NOT NULL
);

COMMENT ON TABLE hivecentral.model_capability IS
    '8-entry controlled capability vocabulary. model.capabilities[] values must be drawn from this set.';

-- ── model — canonical model catalogue ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hivecentral.model (
    id                  BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_name          TEXT         NOT NULL UNIQUE,
    provider            TEXT         NOT NULL,   -- anthropic | openai | google | nous | xiaomi | …
    family              TEXT,                     -- claude | gpt | gemini | mimo | …
    max_context_tokens  INT,
    max_output_tokens   INT,
    is_deprecated       BOOLEAN      NOT NULL DEFAULT false,
    successor_model_id  BIGINT       REFERENCES hivecentral.model(id) ON DELETE SET NULL,
    capabilities        TEXT[]       NOT NULL DEFAULT '{}',
    metadata            JSONB        NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT model_capabilities_valid CHECK (
        capabilities <@ ARRAY[
            'long-context', 'tool-use', 'vision', 'code-review',
            'structured-output', 'reasoning', 'streaming', 'cache-aware'
        ]
    )
);

COMMENT ON TABLE  hivecentral.model IS
    'Canonical model catalogue. One row per unique (provider, model_name) combination.';
COMMENT ON COLUMN hivecentral.model.capabilities IS
    'Subset of hivecentral.model_capability.name. CHECK constraint enforces the 8-entry vocabulary.';
COMMENT ON COLUMN hivecentral.model.successor_model_id IS
    'When is_deprecated=true, points to the recommended drop-in replacement.';

-- ── model_route — dispatch routes (unit of selection, not models) ─────────────

CREATE TABLE IF NOT EXISTS hivecentral.model_route (
    id                      BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_name              TEXT         NOT NULL UNIQUE,
    model_id                BIGINT       NOT NULL REFERENCES hivecentral.model(id) ON DELETE RESTRICT,

    -- Transport / CLI
    route_provider          TEXT         NOT NULL,   -- anthropic | openai | nous | xiaomi | github | google
    api_spec                TEXT         NOT NULL,   -- anthropic | openai | google  (wire protocol)
    agent_cli               TEXT,                    -- claude | hermes | copilot | codex | gemini
    cli_path                TEXT,                    -- full path or NULL (rely on $PATH)

    -- Dispatch scheduling
    priority                SMALLINT     NOT NULL DEFAULT 5,
    is_enabled              BOOLEAN      NOT NULL DEFAULT true,
    is_default              BOOLEAN      NOT NULL DEFAULT false,

    -- Rate limits (NULL = no limit tracked)
    rate_limit_rpm          INT,
    rate_limit_tpd          BIGINT,

    -- Pricing — dual representation; 1M-based is canonical going forward; 1k kept for backward compat
    cost_per_1k_input       NUMERIC(12,8),
    cost_per_1k_output      NUMERIC(12,8),
    cost_per_1m_input       NUMERIC(12,6),
    cost_per_1m_output      NUMERIC(12,6),
    cost_per_1m_cache_write NUMERIC(12,6),   -- NULL = provider has no separate cache-write price
    cost_per_1m_cache_hit   NUMERIC(12,6),   -- NULL = no cache pricing

    -- Credentials
    api_key_env             TEXT,
    api_key_fallback_env    TEXT,
    base_url_env            TEXT,

    -- Fallback chain (AC-4)
    fallback_route_id       BIGINT       REFERENCES hivecentral.model_route(id) ON DELETE SET NULL,
    fallback_condition      TEXT,    -- rate_limit | error_5xx | context_overflow | cost_threshold | any

    -- Agent toolset control
    spawn_toolsets          TEXT,
    objective_rating        NUMERIC,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- AC-2: at least one pricing representation must be populated
    CONSTRAINT route_has_price CHECK (
        cost_per_1k_input IS NOT NULL OR cost_per_1m_input IS NOT NULL
    ),
    CONSTRAINT route_priority_range CHECK (priority BETWEEN 1 AND 10),
    CONSTRAINT route_fallback_condition_valid CHECK (
        fallback_condition IS NULL OR
        fallback_condition IN ('rate_limit', 'error_5xx', 'context_overflow', 'cost_threshold', 'any')
    )
);

COMMENT ON TABLE  hivecentral.model_route IS
    'Dispatch routes — unit of selection. One model can have multiple routes (fast/cheap/batch/fallback variants).';
COMMENT ON COLUMN hivecentral.model_route.fallback_route_id IS
    'Declarative fallback chain: if this route fails under fallback_condition, selector tries fallback_route_id next.';
COMMENT ON COLUMN hivecentral.model_route.fallback_condition IS
    'Trigger condition for fallback. NULL = never auto-trigger fallback.';
COMMENT ON COLUMN hivecentral.model_route.cost_per_1m_input IS
    'Canonical billing price (USD per 1M input tokens). cost_per_1k_* retained for backward compatibility.';
COMMENT ON COLUMN hivecentral.model_route.cli_path IS
    'Full filesystem path to CLI binary. NULL = rely on $PATH. Example: /home/gary/.local/bin/copilot';

-- ── host_model_policy — per-row explicit (host, route) policy (AC-3) ──────────

CREATE TABLE IF NOT EXISTS hivecentral.host_model_policy (
    id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    host         TEXT         NOT NULL,
    route_id     BIGINT       NOT NULL REFERENCES hivecentral.model_route(id) ON DELETE CASCADE,
    is_allowed   BOOLEAN      NOT NULL,
    deny_reason  TEXT,
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (host, route_id),
    CONSTRAINT deny_requires_reason CHECK (
        is_allowed = true OR deny_reason IS NOT NULL
    )
);

COMMENT ON TABLE  hivecentral.host_model_policy IS
    'Explicit per-row (host, route) policy. Replaces v1 TEXT[] allowed/forbidden arrays. is_allowed=false requires deny_reason.';
COMMENT ON COLUMN hivecentral.host_model_policy.deny_reason IS
    'Human-readable denial reason, required when is_allowed=false. Surfaced in SPAWN_POLICY_VIOLATION escalations.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_hc_model_route_model_id
    ON hivecentral.model_route (model_id);

CREATE INDEX IF NOT EXISTS idx_hc_model_route_enabled_priority
    ON hivecentral.model_route (priority)
    WHERE is_enabled = true;

CREATE INDEX IF NOT EXISTS idx_hc_model_route_provider
    ON hivecentral.model_route (route_provider);

CREATE INDEX IF NOT EXISTS idx_hc_model_route_fallback
    ON hivecentral.model_route (fallback_route_id)
    WHERE fallback_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hc_host_policy_host
    ON hivecentral.host_model_policy (host, is_allowed);

-- One default per route_provider (AC-3 enforcement at index level)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_hc_route_provider_default
    ON hivecentral.model_route (route_provider)
    WHERE is_default = true;

-- ── updated_at trigger function ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION hivecentral.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hc_model_updated_at') THEN
        CREATE TRIGGER trg_hc_model_updated_at
            BEFORE UPDATE ON hivecentral.model
            FOR EACH ROW EXECUTE FUNCTION hivecentral.fn_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hc_model_route_updated_at') THEN
        CREATE TRIGGER trg_hc_model_route_updated_at
            BEFORE UPDATE ON hivecentral.model_route
            FOR EACH ROW EXECUTE FUNCTION hivecentral.fn_set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hc_host_policy_updated_at') THEN
        CREATE TRIGGER trg_hc_host_policy_updated_at
            BEFORE UPDATE ON hivecentral.host_model_policy
            FOR EACH ROW EXECUTE FUNCTION hivecentral.fn_set_updated_at();
    END IF;
END $$;

-- ── Views ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW hivecentral.v_active_routes AS
SELECT
    mr.id                       AS route_id,
    mr.route_name,
    mr.route_provider,
    mr.api_spec,
    mr.agent_cli,
    mr.cli_path,
    mr.priority,
    mr.is_default,
    mr.rate_limit_rpm,
    mr.rate_limit_tpd,
    mr.cost_per_1m_input,
    mr.cost_per_1m_output,
    mr.cost_per_1m_cache_write,
    mr.cost_per_1m_cache_hit,
    mr.fallback_route_id,
    mr.fallback_condition,
    mr.api_key_env,
    mr.base_url_env,
    m.model_name,
    m.provider                  AS model_provider,
    m.capabilities              AS model_capabilities,
    m.max_context_tokens,
    m.max_output_tokens,
    m.is_deprecated
FROM  hivecentral.model_route mr
JOIN  hivecentral.model        m  ON m.id = mr.model_id
WHERE mr.is_enabled   = true
  AND m.is_deprecated = false;

COMMENT ON VIEW hivecentral.v_active_routes IS
    'Enabled, non-deprecated routes with joined model metadata. Primary input for the dispatch selector.';

CREATE OR REPLACE VIEW hivecentral.v_route_policy AS
SELECT
    hp.host,
    hp.is_allowed,
    hp.deny_reason,
    mr.id              AS route_id,
    mr.route_name,
    mr.route_provider,
    mr.api_spec,
    m.model_name,
    m.capabilities     AS model_capabilities
FROM  hivecentral.host_model_policy hp
JOIN  hivecentral.model_route       mr ON mr.id = hp.route_id
JOIN  hivecentral.model              m  ON m.id  = mr.model_id;

COMMENT ON VIEW hivecentral.v_route_policy IS
    'Flattened host policy — joins host_model_policy + route + model for single-query policy evaluation.';

-- ── Seed: 8 capability vocabulary entries (AC-6) ──────────────────────────────

INSERT INTO hivecentral.model_capability (name, description) VALUES
    ('long-context',      'Supports context windows larger than 32 k tokens'),
    ('tool-use',          'Provider function-calling / tool-use API'),
    ('vision',            'Multimodal image understanding'),
    ('code-review',       'Code analysis, review, and generation'),
    ('structured-output', 'JSON-mode / constrained structured generation'),
    ('reasoning',         'Extended thinking / scratchpad chain-of-thought'),
    ('streaming',         'Supports incremental streaming token responses'),
    ('cache-aware',       'Provider-side prompt caching with distinct cache-write and cache-hit pricing')
ON CONFLICT (name) DO NOTHING;

-- ── Seed: Claude models — Anthropic family (AC-6) ─────────────────────────────

INSERT INTO hivecentral.model (model_name, provider, family, max_context_tokens, max_output_tokens, capabilities)
VALUES
    ('claude-opus-4-7',
     'anthropic', 'claude', 200000, 32000,
     ARRAY['long-context','tool-use','vision','code-review','structured-output','reasoning','streaming','cache-aware']),
    ('claude-sonnet-4-6',
     'anthropic', 'claude', 200000, 64000,
     ARRAY['long-context','tool-use','vision','code-review','structured-output','reasoning','streaming','cache-aware']),
    ('claude-haiku-4-5',
     'anthropic', 'claude', 200000,  8096,
     ARRAY['long-context','tool-use','vision','structured-output','streaming','cache-aware'])
ON CONFLICT (model_name) DO UPDATE
    SET provider           = EXCLUDED.provider,
        family             = EXCLUDED.family,
        max_context_tokens = EXCLUDED.max_context_tokens,
        max_output_tokens  = EXCLUDED.max_output_tokens,
        capabilities       = EXCLUDED.capabilities,
        updated_at         = now();

-- ── Seed: Claude routes — Anthropic API (AC-6) ───────────────────────────────
-- Seeded as is_enabled=false: host policy on this host (bot/hermes) forbids anthropic provider.
-- Enable on claude-box or any host where anthropic is in allowed_providers.

INSERT INTO hivecentral.model_route (
    route_name,   model_id,
    route_provider, api_spec, agent_cli,
    priority, is_enabled, is_default,
    cost_per_1m_input,  cost_per_1m_output,
    cost_per_1m_cache_write, cost_per_1m_cache_hit,
    cost_per_1k_input,  cost_per_1k_output,
    api_key_env, base_url_env
)
SELECT
    v.route_name,
    m.id  AS model_id,
    v.route_provider, v.api_spec, v.agent_cli,
    v.priority, v.is_enabled, v.is_default,
    v.cost_per_1m_input,  v.cost_per_1m_output,
    v.cost_per_1m_cache_write, v.cost_per_1m_cache_hit,
    v.cost_per_1k_input,  v.cost_per_1k_output,
    v.api_key_env, v.base_url_env
FROM (VALUES
    ('claude-opus-4-7-anthropic',   'claude-opus-4-7',
     'anthropic', 'anthropic', 'claude',
     3::SMALLINT, false, false,
     15.000::NUMERIC(12,6), 75.000::NUMERIC(12,6), 18.750::NUMERIC(12,6), 1.500::NUMERIC(12,6),
     0.015000::NUMERIC(12,8), 0.075000::NUMERIC(12,8),
     'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'),
    ('claude-sonnet-4-6-anthropic', 'claude-sonnet-4-6',
     'anthropic', 'anthropic', 'claude',
     3::SMALLINT, false, false,
     3.000::NUMERIC(12,6),  15.000::NUMERIC(12,6),  3.750::NUMERIC(12,6), 0.300::NUMERIC(12,6),
     0.003000::NUMERIC(12,8), 0.015000::NUMERIC(12,8),
     'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'),
    ('claude-haiku-4-5-anthropic',  'claude-haiku-4-5',
     'anthropic', 'anthropic', 'claude',
     3::SMALLINT, false, false,
     0.250::NUMERIC(12,6),   1.250::NUMERIC(12,6),  0.312::NUMERIC(12,6), 0.025::NUMERIC(12,6),
     0.000250::NUMERIC(12,8), 0.001250::NUMERIC(12,8),
     'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL')
) AS v(
    route_name,   model_name_ref,
    route_provider, api_spec, agent_cli,
    priority, is_enabled, is_default,
    cost_per_1m_input,  cost_per_1m_output,
    cost_per_1m_cache_write, cost_per_1m_cache_hit,
    cost_per_1k_input,  cost_per_1k_output,
    api_key_env, base_url_env
)
JOIN hivecentral.model m ON m.model_name = v.model_name_ref
ON CONFLICT (route_name) DO UPDATE
    SET model_id                = EXCLUDED.model_id,
        cost_per_1m_input       = EXCLUDED.cost_per_1m_input,
        cost_per_1m_output      = EXCLUDED.cost_per_1m_output,
        cost_per_1m_cache_write = EXCLUDED.cost_per_1m_cache_write,
        cost_per_1m_cache_hit   = EXCLUDED.cost_per_1m_cache_hit,
        updated_at              = now();

COMMIT;
