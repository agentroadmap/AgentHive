-- Migration 147: P304 — transport_registry table
--
-- Summary:
--   Adds roadmap.transport_registry for observable transport health state.
--   Transports update status and last_heartbeat every 30s.
--   Gateway considers a transport 'offline' when last_heartbeat < now() - interval '90 seconds'.

CREATE TABLE IF NOT EXISTS roadmap.transport_registry (
  transport_id    TEXT PRIMARY KEY,
  channel         TEXT NOT NULL
    CHECK (channel IN ('discord', 'email', 'sms', 'push', 'digest')),
  status          TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('online', 'offline', 'degraded', 'unknown')),
  last_heartbeat  TIMESTAMPTZ,
  config          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.transport_registry IS
'Live health registry for notification transport adapters (P304).
Transports upsert their status and last_heartbeat every 30s.
Gateway marks a transport offline when last_heartbeat < now() - 90s.
status IN (online, offline, degraded, unknown).';
