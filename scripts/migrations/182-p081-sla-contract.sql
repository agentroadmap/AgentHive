-- P081: SLA contract tables and default configuration
-- Creates tables for SLA tracking and event logging

CREATE TABLE IF NOT EXISTS roadmap.sla_config (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap.sla_events (
  id BIGSERIAL PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('normal', 'degraded', 'down')),
  previous_state TEXT CHECK (previous_state IN ('normal', 'degraded', 'down')),
  triggered_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  trigger_metric TEXT,
  trigger_value NUMERIC,
  details JSONB
);

-- Insert default SLA configuration
INSERT INTO roadmap.sla_config (key, value, description)
VALUES
  ('p99_latency_ms', '500', 'p99 MCP tool call latency threshold in ms'),
  ('error_rate_threshold_pct', '10', 'Error rate % triggering degraded state'),
  ('error_rate_window_seconds', '30', 'Rolling window for error rate calculation'),
  ('availability_target_pct', '99.5', 'Monthly availability target'),
  ('rto_minutes', '5', 'Recovery time objective in minutes'),
  ('lease_ttl_minutes', '30', 'Default agent lease TTL in minutes'),
  ('concurrent_agents_baseline', '100', 'Baseline concurrent agent count for SLA targets')
ON CONFLICT (key) DO NOTHING;
