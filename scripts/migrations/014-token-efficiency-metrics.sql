-- Migration 014: Token Efficiency Metrics Schema
-- Prerequisites: roadmap schema must exist (migration 002+)
-- Purpose: Instrumentation layer for P090 token efficiency tracking.
--   Creates metrics.token_efficiency table for per-invocation cost tracking,
--   and token_cache schema for future semantic cache layer.
-- Compatibility: Additive only. No changes to existing roadmap.* tables.

-- ── Schema creation ────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS token_cache;

-- ── metrics.token_efficiency ───────────────────────────────────────────────
-- Tracks token usage and cost per agent invocation.
-- cache_hit_rate is derived: cache_read_tokens / input_tokens.
-- cost_microdollars uses integer (microdollars) to avoid float precision issues.

CREATE TABLE IF NOT EXISTS metrics.token_efficiency (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid,                        -- agent session if tracked
  agent_role         text,                        -- e.g. implementer, reviewer
  model              text        NOT NULL,        -- full model ID
  task_type          text,                        -- e.g. rfc_review, lint, implement
  proposal_id        text,                        -- roadmap proposal (e.g. P085)

  -- Raw counts from Anthropic API response usage object
  input_tokens       int         NOT NULL DEFAULT 0,
  output_tokens      int         NOT NULL DEFAULT 0,
  cache_write_tokens int         NOT NULL DEFAULT 0,
  cache_read_tokens  int         NOT NULL DEFAULT 0,

  -- Derived: cache_read / input_tokens (0 if no input)
  cache_hit_rate     numeric     GENERATED ALWAYS AS (
    CASE WHEN input_tokens > 0
    THEN cache_read_tokens::numeric / input_tokens
    ELSE 0 END
  ) STORED,

  -- Cost in microdollars (1 USD = 1_000_000 microdollars)
  cost_microdollars  bigint,

  recorded_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE metrics.token_efficiency IS
  'Per-invocation token usage and cost tracking for P090 efficiency monitoring.';
COMMENT ON COLUMN metrics.token_efficiency.cache_hit_rate IS
  'Fraction of input tokens served from cache (0.0–1.0). Target: 0.70+';
COMMENT ON COLUMN metrics.token_efficiency.cost_microdollars IS
  'Total cost in microdollars (USD × 1_000_000) to avoid float precision loss.';

-- Indexes for common reporting queries
CREATE INDEX IF NOT EXISTS idx_token_efficiency_recorded_at
  ON metrics.token_efficiency (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_efficiency_agent_role
  ON metrics.token_efficiency (agent_role, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_efficiency_model
  ON metrics.token_efficiency (model, recorded_at DESC);

-- ── token_cache.semantic_responses ────────────────────────────────────────
-- Semantic cache layer for ~30% query interception before LLM calls.
-- Requires pgvector extension. Skip the vector index if pgvector unavailable.

CREATE TABLE IF NOT EXISTS token_cache.semantic_responses (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash  text        NOT NULL,              -- exact-match fast path
  query_text  text        NOT NULL,
  response    jsonb       NOT NULL,
  agent_role  text,                              -- scope cache by agent type
  model       text        NOT NULL,

  -- Token counts from the original LLM call (for ROI accounting)
  input_tokens  int,
  output_tokens int,

  hit_count   int         NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Exact-match lookup index
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_responses_hash_role
  ON token_cache.semantic_responses (query_hash, agent_role);

CREATE INDEX IF NOT EXISTS idx_semantic_responses_hit_count
  ON token_cache.semantic_responses (hit_count DESC);

COMMENT ON TABLE token_cache.semantic_responses IS
  'Semantic response cache for P090 tier-1 token savings. Embedding column added in a later migration once pgvector is confirmed available.';

-- ── Weekly target view ─────────────────────────────────────────────────────
-- Convenience: rolling 7-day efficiency summary per model/role.

CREATE OR REPLACE VIEW metrics.v_weekly_efficiency AS
SELECT
  date_trunc('week', recorded_at)                         AS week_start,
  agent_role,
  model,
  count(*)                                                AS invocations,
  sum(input_tokens)                                       AS total_input_tokens,
  sum(output_tokens)                                      AS total_output_tokens,
  sum(cache_read_tokens)                                  AS total_cache_read_tokens,
  round(avg(cache_hit_rate), 3)                           AS avg_cache_hit_rate,
  sum(cost_microdollars)                                  AS total_cost_microdollars
FROM metrics.token_efficiency
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 5 DESC;

COMMENT ON VIEW metrics.v_weekly_efficiency IS
  'Rolling weekly token efficiency summary. Track avg_cache_hit_rate toward 0.70 target.';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Allow the application role to write and read metrics data.

GRANT USAGE ON SCHEMA metrics TO roadmap_agent;
GRANT USAGE ON SCHEMA token_cache TO roadmap_agent;
GRANT INSERT ON metrics.token_efficiency TO roadmap_agent;
GRANT SELECT ON metrics.token_efficiency TO roadmap_agent;
GRANT SELECT ON metrics.v_weekly_efficiency TO roadmap_agent;
GRANT SELECT, INSERT, UPDATE, DELETE ON token_cache.semantic_responses TO roadmap_agent;

-- ── Verification queries ───────────────────────────────────────────────────
-- After applying this migration, confirm with:
--   SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('metrics','token_cache');
--   SELECT column_name FROM information_schema.columns WHERE table_schema='metrics' AND table_name='token_efficiency';
--   SELECT * FROM metrics.v_weekly_efficiency LIMIT 1;
