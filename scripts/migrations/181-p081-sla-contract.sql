-- P081: SLA contract support tables
-- roadmap.sla_config  — runtime-configurable alerting thresholds
-- roadmap.sla_events  — SLA breach event log

-- ─── sla_config ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.sla_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default thresholds (idempotent — ON CONFLICT DO NOTHING preserves operator overrides)
INSERT INTO roadmap.sla_config (key, value, description) VALUES
  ('latency_p99_ms_threshold', '500',                  'p99 latency threshold (ms) triggering Degraded state'),
  ('error_rate_pct_threshold', '10',                   'Error rate % threshold triggering Degraded state'),
  ('error_window_seconds',     '30',                   'Rolling window (s) for error rate measurement'),
  ('latency_window_seconds',   '300',                  'Rolling window (s) for latency p99 measurement'),
  ('degraded_sustain_seconds', '30',                   'Breach must persist this many seconds before state changes'),
  ('stale_agent_pct_threshold','20',                   '% stale agents triggering Degraded'),
  ('lease_ttl_minutes',        '30',                   'Default lease TTL for all proposal types'),
  ('alert_channel',            'platform.alerts',      'NOTIFY channel for SLA breach alerts'),
  ('maintenance_channel',      'platform.maintenance', 'NOTIFY channel for planned maintenance')
ON CONFLICT (key) DO NOTHING;

-- ─── sla_events ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.sla_events (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  state        TEXT NOT NULL CHECK (state IN ('Normal','Degraded','Down')),
  prev_state   TEXT         CHECK (prev_state IN ('Normal','Degraded','Down')),
  trigger      TEXT NOT NULL,  -- which metric breached: latency_p99|error_rate|postgres|fleet
  metric_value NUMERIC,
  threshold    NUMERIC,
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sla_events_occurred_at ON roadmap.sla_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sla_events_state       ON roadmap.sla_events(state);

-- ─── permissions ─────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON roadmap.sla_config TO roadmap_agent;
GRANT SELECT, INSERT, UPDATE ON roadmap.sla_events TO roadmap_agent;
GRANT USAGE, SELECT ON SEQUENCE roadmap.sla_events_id_seq TO roadmap_agent;
