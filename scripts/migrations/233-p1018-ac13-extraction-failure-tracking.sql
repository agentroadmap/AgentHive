-- P1018 AC-13: Extraction-failure alarm tracking table
-- Tracks per-provider extraction failures to detect >5%/hr threshold
-- Used to fire roadmap.notification_queue alerts when quality degrades

CREATE TABLE IF NOT EXISTS roadmap.extraction_failure_tracking (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL, -- 'anthropic', 'openai', 'google', 'copilot'
  agent_run_id BIGINT NOT NULL,
  extraction_success BOOLEAN NOT NULL, -- true if adapter returned non-NULL tokens
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_id) REFERENCES roadmap_workforce.agent_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_extraction_failure_tracking_provider_time
  ON roadmap.extraction_failure_tracking(provider, recorded_at);

-- View to compute failure rate per provider over rolling 1-hour windows
CREATE OR REPLACE VIEW roadmap.v_extraction_failure_rate AS
  SELECT
    provider,
    COUNT(*) FILTER (WHERE extraction_success = false) as failure_count,
    COUNT(*) as total_count,
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE extraction_success = false) / NULLIF(COUNT(*), 0),
      2
    ) as failure_rate_percent,
    MAX(recorded_at) as most_recent,
    now() - interval '1 hour' as window_start
  FROM roadmap.extraction_failure_tracking
  WHERE recorded_at > now() - interval '1 hour'
  GROUP BY provider;

-- Table to track alarm cooldown (avoid spam notifications)
CREATE TABLE IF NOT EXISTS roadmap.extraction_failure_alarm_cooldown (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  last_alarm_at TIMESTAMP WITH TIME ZONE NOT NULL,
  alarm_count INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_extraction_alarm_cooldown_provider
  ON roadmap.extraction_failure_alarm_cooldown(provider);
