/**
 * P747 AC-6: Token Budget Lazy-Recomputation
 *
 * Creates route_token_budget table for per-project-route hourly token limits.
 * Supports lazy hourly window reset on hot path with atomic UPSERT.
 *
 * Schema authority: roadmap_efficiency (efficiency metrics)
 */

-- Create route_token_budget table
CREATE TABLE IF NOT EXISTS roadmap_efficiency.route_token_budget (
  project_id BIGINT NOT NULL,
  route_id BIGINT NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  window_hours INTEGER NOT NULL DEFAULT 1,
  tokens_cap BIGINT NOT NULL DEFAULT 1000000,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  PRIMARY KEY (project_id, route_id),
  CONSTRAINT tokens_used_non_negative CHECK (tokens_used >= 0),
  CONSTRAINT tokens_cap_positive CHECK (tokens_cap > 0),
  CONSTRAINT window_hours_positive CHECK (window_hours > 0)
);

-- Index for lazy-reset hot path (window expiration check)
CREATE INDEX IF NOT EXISTS idx_route_token_budget_window_expiry
  ON roadmap_efficiency.route_token_budget (project_id, window_start, window_hours)
  WHERE tokens_used >= tokens_cap;

-- Index for querying exhausted budgets
CREATE INDEX IF NOT EXISTS idx_route_token_budget_exhausted
  ON roadmap_efficiency.route_token_budget (project_id, tokens_used DESC)
  WHERE tokens_used >= tokens_cap;

-- Grant permissions to orchestrator role
GRANT SELECT, INSERT, UPDATE ON roadmap_efficiency.route_token_budget TO agenthive_orchestrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA roadmap_efficiency TO agenthive_orchestrator;
