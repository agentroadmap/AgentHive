-- P464: Agency Registration, Liaison Sessions, and Dormancy State Machine
--
-- Establishes first-class agency entities with heartbeat tracking, dormancy detection,
-- and status lifecycle management. Agencies register via liaison processes and emit
-- periodic heartbeats to signal active operation.

BEGIN;

-- ─── Agency Table ───────────────────────────────────────────────────────────
-- Represents a first-class agency entity (e.g., 'hermes/agency-xiaomi', 'claude/code-gary')
CREATE TABLE IF NOT EXISTS roadmap.agency (
  agency_id text PRIMARY KEY,
  display_name text NOT NULL,
  provider text NOT NULL,                    -- 'anthropic', 'openai', 'xiaomi', etc.
  host_id text NOT NULL,                     -- FK to roadmap.host_model_policy.host_name
  capability_tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'unknown',    -- active|throttled|paused|dormant|retired
  status_reason text,
  last_heartbeat_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);

ALTER TABLE roadmap.agency
  ADD CONSTRAINT fk_agency_host_id
  FOREIGN KEY (host_id) REFERENCES roadmap.host_model_policy(host_name);

CREATE INDEX IF NOT EXISTS idx_agency_status ON roadmap.agency(status);
CREATE INDEX IF NOT EXISTS idx_agency_last_heartbeat ON roadmap.agency(last_heartbeat_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_agency_provider ON roadmap.agency(provider);

-- ─── Agency Liaison Session Table ───────────────────────────────────────────
-- Represents a session between a liaison process and the orchestrator.
-- Multiple sessions per agency may exist (e.g., across restarts), but only one
-- is active at a time per agency (or the previous one has ended).
CREATE TABLE IF NOT EXISTS roadmap.agency_liaison_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id text NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
  liaison_pid integer,                       -- Process ID of the liaison (may be null if unknown)
  liaison_host text,                         -- Hostname where liaison runs
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text                            -- normal|crash|operator|throttle
);

CREATE INDEX IF NOT EXISTS idx_liaison_session_agency ON roadmap.agency_liaison_session(agency_id);
CREATE INDEX IF NOT EXISTS idx_liaison_session_started ON roadmap.agency_liaison_session(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_liaison_session_ended ON roadmap.agency_liaison_session(ended_at DESC NULLS LAST);

-- ─── Agency Status View ─────────────────────────────────────────────────────
-- Single source of truth for agency dispatch eligibility. Used by orchestrator
-- to determine which agencies can accept new work.
CREATE OR REPLACE VIEW roadmap.v_agency_status AS
SELECT
  agency_id,
  display_name,
  provider,
  host_id,
  status,
  last_heartbeat_at,
  EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) AS silence_seconds,
  (
    status = 'active'
    AND last_heartbeat_at IS NOT NULL
    AND (now() - last_heartbeat_at) < interval '90 seconds'
  ) AS dispatchable,
  registered_at,
  metadata
FROM roadmap.agency
WHERE status <> 'retired';

-- ─── Trigger: Auto-dormancy on stale heartbeat ────────────────────────────
-- This trigger fires on any INSERT/UPDATE to agency_liaison_session.
-- If there is a gap between now() and the last_heartbeat_at > 90s, mark as dormant.
-- Note: Liaison processes are responsible for periodically heartbeating.
-- The database does not automatically transition; detection happens at read time
-- or via scheduled checks. For now, we provide the infrastructure for manual checks.

CREATE OR REPLACE FUNCTION roadmap.fn_check_agency_dormancy()
RETURNS void AS $$
BEGIN
  UPDATE roadmap.agency
  SET
    status = 'dormant',
    status_reason = 'No heartbeat > 90s'
  WHERE
    status IN ('active', 'throttled')
    AND last_heartbeat_at IS NOT NULL
    AND (now() - last_heartbeat_at) > interval '90 seconds';
END;
$$ LANGUAGE plpgsql;

-- Permit manual calls:
-- SELECT roadmap.fn_check_agency_dormancy();

COMMIT;
