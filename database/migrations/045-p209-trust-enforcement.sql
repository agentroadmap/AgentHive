-- P209: Trust Enforcement — Agent Lifecycle Integration & System Guard
--
-- Adds escalation tracking table for repeated message denials and
-- unauthorized transition attempts.

-- Create schema if needed
CREATE SCHEMA IF NOT EXISTS roadmap_control;

-- Escalation table for security events
CREATE TABLE IF NOT EXISTS roadmap_control.escalation (
	id BIGSERIAL PRIMARY KEY,
	type TEXT NOT NULL CHECK (type IN ('REPEATED_MESSAGE_DENIAL', 'UNAUTHORIZED_GATE_TRANSITION')),
	agent_identity TEXT NOT NULL,
	details TEXT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
	acknowledged BOOLEAN DEFAULT FALSE,
	acknowledged_by TEXT,
	acknowledged_at TIMESTAMP WITH TIME ZONE,

	-- Unique constraint to avoid duplicate escalations for same agent+type in short window
	UNIQUE (type, agent_identity, created_at)
);

CREATE INDEX IF NOT EXISTS idx_escalation_agent ON roadmap_control.escalation(agent_identity);
CREATE INDEX IF NOT EXISTS idx_escalation_type ON roadmap_control.escalation(type);
CREATE INDEX IF NOT EXISTS idx_escalation_created ON roadmap_control.escalation(created_at DESC);

-- Ensure denied_messages table has all required columns (should exist from P208)
-- This is a safety check in case it wasn't fully set up
CREATE TABLE IF NOT EXISTS roadmap_messaging.denied_messages (
	id BIGSERIAL PRIMARY KEY,
	from_agent TEXT NOT NULL,
	to_agent TEXT,
	message_type TEXT,
	reason TEXT NOT NULL,
	trust_tier TEXT,
	timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_denied_messages_agent_timestamp
	ON roadmap_messaging.denied_messages(from_agent, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_denied_messages_recent
	ON roadmap_messaging.denied_messages(timestamp DESC);
