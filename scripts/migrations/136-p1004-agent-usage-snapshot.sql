-- env: prod
-- P1004 — Agent cost & quota self-reporting: agent_usage_snapshot table
-- Agents call ops_report_usage after each significant LLM API interaction.
-- The table captures token counts, cache efficiency, and provider quota state.
-- A pg_notify is emitted when quota_remaining drops below 20% of quota_limit.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_usage_snapshot (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              text        NOT NULL,
  agent_identity        text        NOT NULL,
  session_id            text,
  tokens_in             int,
  tokens_out            int,
  cache_creation_tokens int         NOT NULL DEFAULT 0,
  cache_read_tokens     int         NOT NULL DEFAULT 0,
  quota_remaining       int,
  quota_limit           int,
  quota_reset_at        timestamptz,
  cost_usd_estimate     numeric(10,6),
  raw_headers           jsonb,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_workforce.agent_usage_snapshot IS
  'Point-in-time snapshots of LLM API usage and quota state reported by agent subprocesses. '
  'Populated via the ops_report_usage MCP tool. Used by the orchestrator pre-spawn quota check '
  'and the agent_pool_stats cache efficiency summary.';

-- Index for fast "latest snapshot per provider" queries (used by pre-spawn check)
CREATE INDEX IF NOT EXISTS idx_agent_usage_snapshot_provider_recorded_at
  ON roadmap_workforce.agent_usage_snapshot (provider, recorded_at DESC);

-- Index for per-agent history queries
CREATE INDEX IF NOT EXISTS idx_agent_usage_snapshot_agent_recorded_at
  ON roadmap_workforce.agent_usage_snapshot (agent_identity, recorded_at DESC);

-- Trigger: emit pg_notify when quota_remaining < 20% of quota_limit
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_budget_alert_notify()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quota_remaining IS NOT NULL
     AND NEW.quota_limit  IS NOT NULL
     AND NEW.quota_limit  > 0
     AND NEW.quota_remaining::float / NEW.quota_limit < 0.20
  THEN
    PERFORM pg_notify(
      'budget_alert',
      json_build_object(
        'provider',          NEW.provider,
        'agent_identity',    NEW.agent_identity,
        'quota_remaining',   NEW.quota_remaining,
        'quota_limit',       NEW.quota_limit,
        'pct_remaining',     round((NEW.quota_remaining::numeric / NEW.quota_limit) * 100, 1),
        'recorded_at',       NEW.recorded_at
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_alert_notify
  ON roadmap_workforce.agent_usage_snapshot;

CREATE TRIGGER trg_budget_alert_notify
  AFTER INSERT ON roadmap_workforce.agent_usage_snapshot
  FOR EACH ROW EXECUTE FUNCTION roadmap_workforce.fn_budget_alert_notify();

COMMIT;
