-- P770 D4: per-(project, route) hourly token-budget table + window resetter
--
-- Tracks token consumption per project per route per hour window.
-- Layer 5 eligibility filter in resolveModelRoute() reads this table to
-- exclude routes where tokens_consumed >= max_tokens for the current window.
-- max_tokens is sourced from project_route_policy.max_hourly_tokens_by_route.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.route_token_budget (
  project_id      BIGINT      NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  route_provider  TEXT        NOT NULL,
  hour_window     TIMESTAMPTZ NOT NULL,  -- date_trunc('hour', NOW())
  tokens_consumed BIGINT      NOT NULL DEFAULT 0,
  max_tokens      BIGINT,               -- NULL = uncapped; from project_route_policy
  PRIMARY KEY (project_id, route_provider, hour_window)
);

COMMENT ON TABLE roadmap.route_token_budget IS
  'Per-(project, route_provider) hourly token consumption. '
  'Rows older than 7 days are pruned by the budget-pruner scanner.';

CREATE INDEX IF NOT EXISTS idx_route_token_budget_window
  ON roadmap.route_token_budget (hour_window);

CREATE INDEX IF NOT EXISTS idx_route_token_budget_project
  ON roadmap.route_token_budget (project_id, route_provider);

GRANT SELECT ON roadmap.route_token_budget TO agent_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.route_token_budget TO agent_write;

COMMIT;

-- Rollback:
--   DROP TABLE IF EXISTS roadmap.route_token_budget;
