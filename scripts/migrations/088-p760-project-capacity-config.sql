-- P760: Per-project dispatch capacity configuration
-- Stores per-project concurrency limits and hourly token budgets.
-- The capacity-guard resolver reads this table before each spawn.

CREATE TABLE IF NOT EXISTS roadmap.project_capacity_config (
  project_id                BIGINT PRIMARY KEY REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  max_concurrent_dispatches INT NOT NULL DEFAULT 50 CHECK (max_concurrent_dispatches >= 0),
  max_hourly_token_budget   BIGINT,
  notes                     TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE roadmap.project_capacity_config IS
  'Per-project caps on concurrent agent dispatches and hourly token spend. Absence of a row means the project is uncapped.';

-- Seed: agenthive (project_id=1) gets conservative defaults.
INSERT INTO roadmap.project_capacity_config (project_id, max_concurrent_dispatches, max_hourly_token_budget)
  VALUES (1, 8, 500000)
  ON CONFLICT (project_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON roadmap.project_capacity_config TO agent_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.project_capacity_config TO agent_write;
