-- P209: Trust Enforcement — Denied Messages & Escalation Types
-- Creates the denied_messages audit table and adds new escalation types.

-- 1. denied_messages table for logging blocked message attempts
CREATE TABLE IF NOT EXISTS roadmap_messaging.denied_messages (
    id              BIGSERIAL PRIMARY KEY,
    from_agent      TEXT NOT NULL,
    to_agent        TEXT,
    message_type    TEXT,
    reason          TEXT NOT NULL,
    trust_tier      TEXT,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups by agent pair + time window (escalation counting)
CREATE INDEX IF NOT EXISTS idx_denied_messages_agents_timestamp
    ON roadmap_messaging.denied_messages (from_agent, to_agent, timestamp);

-- Index for recent denials query (5-min window)
CREATE INDEX IF NOT EXISTS idx_denied_messages_timestamp
    ON roadmap_messaging.denied_messages (timestamp DESC);

-- 2. Add trust enforcement escalation types to escalation_log constraint
-- First check if constraint exists and drop it
DO $$
BEGIN
    -- Drop old constraint if exists
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'escalation_log_obstacle_type_check'
        AND table_schema = 'roadmap'
        AND table_name = 'escalation_log'
    ) THEN
        ALTER TABLE roadmap.escalation_log DROP CONSTRAINT escalation_log_obstacle_type_check;
    END IF;
END $$;

-- Add updated constraint with new types + existing types
ALTER TABLE roadmap.escalation_log
    ADD CONSTRAINT escalation_log_obstacle_type_check
    CHECK (obstacle_type IN (
        'BUDGET_EXHAUSTED',
        'LOOP_DETECTED',
        'CYCLE_DETECTED',
        'AGENT_DEAD',
        'PIPELINE_BLOCKED',
        'AC_GATE_FAILED',
        'DEPENDENCY_UNRESOLVED',
        'SPAWN_POLICY_VIOLATION',
        'REPEATED_MESSAGE_DENIAL',
        'UNAUTHORIZED_GATE_TRANSITION'
    ));

-- 3. Comment for documentation
COMMENT ON TABLE roadmap_messaging.denied_messages IS 'P209: Audit log of messages blocked by trust enforcement middleware';
COMMENT ON INDEX idx_denied_messages_agents_timestamp IS 'P209: Fast lookup for repeated denial escalation (>3 in 5min)';
