-- P304: transport registry — health state for messaging transport adapters
CREATE TABLE IF NOT EXISTS roadmap.transport_registry (
  transport_id    TEXT PRIMARY KEY,
  channel         TEXT NOT NULL
    CHECK (channel IN ('discord','email','sms','push','digest')),
  status          TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('online','offline','degraded','unknown')),
  last_heartbeat  TIMESTAMPTZ,
  config          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
