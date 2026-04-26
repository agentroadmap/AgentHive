-- P467: Subagent stuck-detection and auto-escalation
-- Adds assistance_request table and related infrastructure

CREATE TABLE IF NOT EXISTS roadmap.assistance_request (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  briefing_id uuid NOT NULL,
  task_id text NOT NULL,
  agency_id text NOT NULL,
  agent_identity text NOT NULL,
  error_signature text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',  -- open|resolved|reassigned|escalated|abandoned
  resolution jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT assistance_request_status_check CHECK (
    status IN ('open', 'resolved', 'reassigned', 'escalated', 'abandoned')
  )
);

CREATE INDEX IF NOT EXISTS assistance_request_open_idx
  ON roadmap.assistance_request (agency_id, status)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS assistance_request_briefing_idx
  ON roadmap.assistance_request (briefing_id);

CREATE INDEX IF NOT EXISTS assistance_request_error_sig_idx
  ON roadmap.assistance_request (error_signature);

-- Spawn briefing configuration table for stuck-detection parameters
-- Stores per-spawn configuration for strike threshold, checkpoint interval, and max tool calls
CREATE TABLE IF NOT EXISTS roadmap.spawn_briefing_config (
  briefing_id uuid PRIMARY KEY,
  request_assistance_threshold integer NOT NULL DEFAULT 3,
  checkpoint_interval integer NOT NULL DEFAULT 5,
  max_tool_calls integer NOT NULL DEFAULT 100,
  low_confidence_strike_weight numeric NOT NULL DEFAULT 0.5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spawn_briefing_config_thresholds CHECK (
    request_assistance_threshold > 0 AND
    checkpoint_interval > 0 AND
    max_tool_calls > 0 AND
    low_confidence_strike_weight > 0 AND
    low_confidence_strike_weight <= 1
  )
);

-- Strike counter per spawn: tracks error signatures and counts
CREATE TABLE IF NOT EXISTS roadmap.spawn_error_strike (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  briefing_id uuid NOT NULL REFERENCES roadmap.spawn_briefing_config(briefing_id) ON DELETE CASCADE,
  error_signature text NOT NULL,
  strike_count numeric NOT NULL DEFAULT 1,
  last_occurrence_at timestamptz NOT NULL DEFAULT now(),
  first_occurrence_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spawn_error_strike_unique UNIQUE (briefing_id, error_signature)
);

CREATE INDEX IF NOT EXISTS spawn_error_strike_briefing_idx
  ON roadmap.spawn_error_strike (briefing_id);

-- Tool call counter and checkpoint tracking per spawn
CREATE TABLE IF NOT EXISTS roadmap.spawn_tool_call_counter (
  briefing_id uuid PRIMARY KEY REFERENCES roadmap.spawn_briefing_config(briefing_id) ON DELETE CASCADE,
  total_tool_calls_made integer NOT NULL DEFAULT 0,
  calls_since_last_checkpoint integer NOT NULL DEFAULT 0,
  last_checkpoint_at timestamptz,
  last_checkpoint_summary text,
  last_checkpoint_confidence text DEFAULT 'med',
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.assistance_request IS
'Tracks assistance requests from stuck subagents. Includes error history, current state, and resolution tracking.';

COMMENT ON TABLE roadmap.spawn_briefing_config IS
'Configuration for stuck-detection parameters per spawn: strike threshold, checkpoint interval, max tool calls.';

COMMENT ON TABLE roadmap.spawn_error_strike IS
'Tracks error signature occurrences per spawn for N-strikes detection.';

COMMENT ON TABLE roadmap.spawn_tool_call_counter IS
'Tracks tool call counts and checkpoint progress per spawn for forced checkpoint enforcement.';
