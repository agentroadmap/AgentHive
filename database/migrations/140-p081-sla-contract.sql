-- P081: SLA Contract Management
-- Purpose: Establish SLA configuration and event tracking tables to monitor system health,
-- define thresholds for degraded/down states, and track state transitions over time.
--
-- Tables:
--   roadmap.sla_config - Centralized SLA configuration (thresholds, windows, channels)
--   roadmap.sla_events - Event log for state transitions and SLA breaches
--
-- Additional indexes:
--   trace_span(operation, started_at DESC) - Query spans by operation and temporal order

BEGIN;

-- Create SLA configuration table (idempotent — may already exist from prior migration)
CREATE TABLE IF NOT EXISTS roadmap.sla_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create SLA events table (idempotent)
CREATE TABLE IF NOT EXISTS roadmap.sla_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    state TEXT NOT NULL CHECK (state = ANY (ARRAY['Normal', 'Degraded', 'Down'])),
    prev_state TEXT CHECK (prev_state = ANY (ARRAY['Normal', 'Degraded', 'Down'])),
    trigger TEXT NOT NULL,
    metric_value NUMERIC,
    threshold NUMERIC,
    resolved_at TIMESTAMPTZ
);

-- Create indexes on sla_events (idempotent)
CREATE INDEX IF NOT EXISTS idx_sla_events_occurred_at ON roadmap.sla_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sla_events_state ON roadmap.sla_events(state);

-- Add trace_span composite index for fast p99 latency queries
CREATE INDEX IF NOT EXISTS idx_trace_span_op_started ON roadmap.trace_span(operation, started_at DESC);

-- Seed default SLA configuration (ON CONFLICT DO NOTHING — idempotent)
INSERT INTO roadmap.sla_config (key, value, description)
VALUES
    ('latency_p99_ms_threshold', '500', 'p99 latency threshold (ms) triggering Degraded state'),
    ('error_rate_pct_threshold', '10', 'Error rate % threshold triggering Degraded state'),
    ('error_window_seconds', '30', 'Rolling window (s) for error rate measurement'),
    ('latency_window_seconds', '300', 'Rolling window (s) for latency p99 measurement'),
    ('degraded_sustain_seconds', '30', 'Breach must persist this many seconds before state changes'),
    ('stale_agent_pct_threshold', '20', 'Percentage of agents considered stale before state change'),
    ('lease_ttl_minutes', '30', 'Default lease time-to-live in minutes'),
    ('alert_channel', 'platform.alerts', 'NOTIFY channel for SLA breach alerts'),
    ('maintenance_channel', 'platform.maintenance', 'NOTIFY channel for planned maintenance announcements')
ON CONFLICT (key) DO NOTHING;

COMMIT;
