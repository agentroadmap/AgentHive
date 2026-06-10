-- 196-p1100-rate-limiter.sql
-- P1100: Per-sender rate limit on msg_send to prevent channel flooding.
--
-- Creates:
-- 1. msg_send_rate_limit_violation: audit/tracking table for 429 rejections
-- 2. msg_send_rate_limit_window: advisory lock + token bucket state (if using PG storage)
--
-- The limiter is enforced in TypeScript code (src/apps/mcp-server/tools/messages/rate-limiter.ts)
-- using either in-memory token buckets (verified singleton MCP process) or a shared
-- Postgres-backed store (this table + advisory locks). The choice is deployment-specific
-- and verified at startup via 'hive doctor'.
--
-- AC-1: Per-sender token bucket 10 msg/sec sustained, 50 burst
-- AC-3: Exponential backoff on repeat violations within 60s window
-- AC-8: 429 responses include Retry-After and audit metrics
-- AC-10: Global channel limit of 50 msg/sec

SET search_path = roadmap, public;

-- Table to track rate-limit violations for observability
-- Every 429 rejection increments this counter with {from_agent, channel, reason, retry_after}
CREATE TABLE IF NOT EXISTS roadmap.msg_send_rate_limit_violation (
    id BIGSERIAL PRIMARY KEY,
    from_agent TEXT NOT NULL,
    channel TEXT,
    reason TEXT NOT NULL, -- 'rate_limited', 'channel_flooded', etc.
    retry_after_seconds INT NOT NULL,
    violation_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    exemption_reason TEXT, -- 'trusted_system_sender' if exempt request somehow gets here (audit)
    metadata JSONB -- {backoff_stage: 0|1|2|3, bucket_tokens_remaining: N}
);

CREATE INDEX IF NOT EXISTS msg_send_rate_limit_violation_from_agent_idx
    ON roadmap.msg_send_rate_limit_violation(from_agent, violation_at DESC);

CREATE INDEX IF NOT EXISTS msg_send_rate_limit_violation_channel_idx
    ON roadmap.msg_send_rate_limit_violation(channel, violation_at DESC);

-- Optional: Advisory lock + token bucket state for shared limiter (Postgres-backed).
-- If using distributed storage (Redis/PG), this table stores the current bucket state
-- keyed by canonicalized from_agent. Each row is protected by an advisory lock
-- pg_advisory_lock(bucket_id) where bucket_id = hash(from_agent).
-- This is only used if the deployment has multiple MCP processes; single-process
-- deployments use in-memory buckets verified by 'hive doctor'.
CREATE TABLE IF NOT EXISTS roadmap.msg_send_rate_limit_bucket (
    bucket_id TEXT PRIMARY KEY, -- canonicalized from_agent
    tokens_available NUMERIC(10, 2) NOT NULL DEFAULT 50, -- burst capacity
    last_refill_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    violation_count INT NOT NULL DEFAULT 0, -- violations in the last 60s
    last_violation_at TIMESTAMP WITH TIME ZONE, -- for backoff calculation
    backoff_stage INT NOT NULL DEFAULT 0, -- 0=2s, 1=4s, 2=8s, 3=60s
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msg_send_rate_limit_bucket_updated_idx
    ON roadmap.msg_send_rate_limit_bucket(updated_at DESC);

-- Table to track per-channel message volume for global channel limit (AC-10)
CREATE TABLE IF NOT EXISTS roadmap.msg_send_channel_limit_window (
    channel TEXT PRIMARY KEY,
    message_count INT NOT NULL DEFAULT 0, -- messages in current 1-second window
    window_start_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msg_send_channel_limit_window_updated_idx
    ON roadmap.msg_send_channel_limit_window(updated_at DESC);

-- Idempotent: all tables are created with IF NOT EXISTS
