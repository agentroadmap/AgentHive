-- P081: SLA contract tables and default configuration
-- Creates tables for SLA tracking and event logging.
-- NOTE: sla_events uses capitalized state names ('Normal'/'Degraded'/'Down') per AC-2.

CREATE TABLE IF NOT EXISTS roadmap.sla_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap.sla_events (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  state        TEXT NOT NULL CHECK (state IN ('Normal', 'Degraded', 'Down')),
  prev_state   TEXT CHECK (prev_state IN ('Normal', 'Degraded', 'Down')),
  trigger      TEXT NOT NULL,
  metric_value NUMERIC,
  threshold    NUMERIC,
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sla_events_occurred_at ON roadmap.sla_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sla_events_state       ON roadmap.sla_events (state);

-- Default SLA thresholds; operator may UPDATE these rows to tune alerting
INSERT INTO roadmap.sla_config (key, value, description) VALUES
  ('latency_p99_ms_threshold',  '500',              'p99 MCP tool call latency threshold (ms); Degraded above this'),
  ('error_rate_pct_threshold',  '10',               'Error rate % over error_window_seconds triggering Degraded state'),
  ('error_window_seconds',      '30',               'Rolling window (seconds) for error rate calculation'),
  ('latency_window_seconds',    '300',              'Rolling window (seconds) for latency histogram (5 min)'),
  ('degraded_sustain_seconds',  '30',               'Seconds Degraded must persist before triggering Down'),
  ('stale_agent_pct_threshold', '20',               'Max % of agents with stale heartbeats before Degraded'),
  ('lease_ttl_minutes',         '30',               'Default agent lease TTL in minutes'),
  ('alert_channel',             'platform.alerts',  'pg_notify channel for SLA state-change events'),
  ('maintenance_channel',       'platform.maintenance', 'pg_notify channel for planned-maintenance announcements')
ON CONFLICT (key) DO NOTHING;
