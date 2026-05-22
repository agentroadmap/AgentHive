-- Migration 132: P465 — Subscription-aware claim policy
--
-- Creates:
--   roadmap.agency_capacity_config  — per-agency quota window definitions
--   roadmap.agency_usage_meter      — local token/request usage accumulator
--
-- Alters:
--   roadmap.agency                  — adds throttled_until timestamptz

BEGIN;

-- ── Config table ──────────────────────────────────────────────────────────────

CREATE TABLE roadmap.agency_capacity_config (
  agency_id         text          NOT NULL PRIMARY KEY
                                  REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
  windows           jsonb         NOT NULL DEFAULT '[]'::jsonb,
  safety_margin     numeric(4,3)  NOT NULL DEFAULT 0.15
                                  CHECK (safety_margin >= 0 AND safety_margin < 1),
  refuse_below_slots integer      NOT NULL DEFAULT 1 CHECK (refuse_below_slots >= 0),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.agency_capacity_config IS
  'P465: per-agency subscription quota configuration. windows jsonb holds an array of '
  '{window_kind, quota_tokens, quota_requests, timezone?}. safety_margin (default 0.15) is '
  'the minimum projected remaining fraction before claims are refused.';

COMMENT ON COLUMN roadmap.agency_capacity_config.windows IS
  'Array of {window_kind: "5h"|"daily"|"weekly"|"monthly"|"custom", quota_tokens?: number, quota_requests?: number}';

-- ── Usage meter ───────────────────────────────────────────────────────────────

CREATE TABLE roadmap.agency_usage_meter (
  id              bigserial   PRIMARY KEY,
  agency_id       text        NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
  window_kind     text        NOT NULL
                              CHECK (window_kind IN ('5h','daily','weekly','monthly','custom')),
  window_start    timestamptz NOT NULL,
  used_tokens     bigint      NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  used_requests   bigint      NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
  source          text        NOT NULL DEFAULT 'local_meter'
                              CHECK (source IN ('provider_api','local_meter','manual')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, window_kind, window_start)
);

CREATE INDEX idx_agency_usage_meter_lookup
  ON roadmap.agency_usage_meter (agency_id, window_kind, window_start);

COMMENT ON TABLE roadmap.agency_usage_meter IS
  'P465: local token/request accumulator per agency per window. Used by subscription-quota '
  'service as the "local_meter" source tier (tier 2 of the three-layer fallback).';

-- ── throttled_until column on agency ─────────────────────────────────────────

ALTER TABLE roadmap.agency
  ADD COLUMN IF NOT EXISTS throttled_until timestamptz;

COMMENT ON COLUMN roadmap.agency.throttled_until IS
  'P465: when set, the agency declared itself throttled until this timestamp due to '
  'subscription quota exhaustion. Cleared when the tightest window resets.';

COMMIT;
