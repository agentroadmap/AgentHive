-- P468: Two-way orchestrator↔liaison messaging protocol
-- Durable message log with LISTEN/NOTIFY support for idempotent replay

CREATE TABLE IF NOT EXISTS roadmap.liaison_message (
    message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Agency & sequencing
    agency_id text NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    sequence bigint NOT NULL,

    -- Message metadata
    direction text NOT NULL CHECK (direction IN ('orchestrator->liaison', 'liaison->orchestrator')),
    kind text NOT NULL,
    correlation_id uuid NOT NULL,

    -- Payload & signature
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    signed_at timestamptz NOT NULL,
    signature text NOT NULL,

    -- Acknowledgment
    acked_at timestamptz,
    ack_outcome text CHECK (ack_outcome IN ('ok', 'reject', 'noop')),
    ack_error text,

    -- Timestamps
    created_at timestamptz NOT NULL DEFAULT now(),

    -- Idempotency: (agency_id, sequence) must be unique
    UNIQUE (agency_id, sequence)
);

-- Indexes for efficient queries
CREATE INDEX idx_liaison_message_agency_sequence
    ON roadmap.liaison_message (agency_id, sequence DESC);

CREATE INDEX idx_liaison_message_agency_direction
    ON roadmap.liaison_message (agency_id, direction);

CREATE INDEX idx_liaison_message_kind
    ON roadmap.liaison_message (kind);

CREATE INDEX idx_liaison_message_correlation_id
    ON roadmap.liaison_message (correlation_id);

CREATE INDEX idx_liaison_message_acked
    ON roadmap.liaison_message (acked_at DESC NULLS LAST);

CREATE INDEX idx_liaison_message_created
    ON roadmap.liaison_message (created_at DESC);

-- Message kind catalog (control plane + telemetry plane)
-- This table documents allowed message kinds and their payload schemas
CREATE TABLE IF NOT EXISTS roadmap.liaison_message_kind_catalog (
    kind text PRIMARY KEY,
    direction text NOT NULL CHECK (direction IN ('orchestrator->liaison', 'liaison->orchestrator', 'bidirectional')),
    category text NOT NULL CHECK (category IN ('control', 'telemetry')),
    payload_schema jsonb NOT NULL,
    description text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Insert message kind catalog entries
INSERT INTO roadmap.liaison_message_kind_catalog (kind, direction, category, payload_schema, description) VALUES
    -- Control plane: orchestrator → liaison
    ('offer_dispatch', 'orchestrator->liaison', 'control', '{"offer_id": "uuid", "role": "string", "required_capabilities": ["string"], "route_hint": "string"}'::jsonb, 'New work offer for the agency'),
    ('claim_revoke', 'orchestrator->liaison', 'control', '{"claim_id": "uuid", "reason": "string"}'::jsonb, 'Force-release a claim'),
    ('liaison_pause', 'orchestrator->liaison', 'control', '{"until_iso": "string|null"}'::jsonb, 'Stop accepting new claims'),
    ('liaison_resume', 'orchestrator->liaison', 'control', '{}'::jsonb, 'Resume accepting claims'),
    ('liaison_drain', 'orchestrator->liaison', 'control', '{"reason": "string"}'::jsonb, 'Finish in-flight, claim no new work, then exit gracefully'),
    ('agency_retire', 'orchestrator->liaison', 'control', '{"reason": "string"}'::jsonb, 'Permanent retirement'),
    ('protocol_ping', 'orchestrator->liaison', 'control', '{"nonce": "string"}'::jsonb, 'Health probe'),
    ('query_capacity', 'orchestrator->liaison', 'control', '{}'::jsonb, 'Request immediate capacity report'),

    -- Control plane: liaison → orchestrator
    ('liaison_register', 'liaison->orchestrator', 'control', '{"agency_id": "string", "provider": "string", "host_id": "string", "capabilities": ["string"], "public_key": "string"}'::jsonb, 'Initial registration'),
    ('claim_offer', 'liaison->orchestrator', 'control', '{"offer_id": "uuid", "agent_identity": "string", "briefing_id": "uuid"}'::jsonb, 'Claim a work offer'),
    ('claim_release', 'liaison->orchestrator', 'control', '{"claim_id": "uuid", "reason": "string"}'::jsonb, 'Voluntary release'),
    ('claim_paused', 'liaison->orchestrator', 'control', '{"claim_id": "uuid", "reason": "string", "resume_eligible_at": "string"}'::jsonb, 'Hit provider hard limit'),
    ('agency_throttle', 'liaison->orchestrator', 'control', '{"until_iso": "string", "reason": "string"}'::jsonb, 'Self-declared throttle'),
    ('agency_active', 'liaison->orchestrator', 'control', '{}'::jsonb, 'Come back from throttle'),
    ('assistance_request', 'liaison->orchestrator', 'control', '{"briefing_id": "uuid", "task_id": "uuid", "error_signature": "string", "payload": {}}'::jsonb, 'Child needs help'),
    ('escalate', 'liaison->orchestrator', 'control', '{"kind": "string", "severity": "string", "payload": {}}'::jsonb, 'Operator escalation'),

    -- Telemetry plane: liaison → orchestrator
    ('heartbeat', 'liaison->orchestrator', 'telemetry', '{"capacity_envelope": {}, "in_flight_count": "integer", "last_error": "string|null"}'::jsonb, 'Every 30s'),
    ('progress_note', 'liaison->orchestrator', 'telemetry', '{"briefing_id": "uuid", "summary": "string", "confidence": "number"}'::jsonb, 'Progress from agents'),
    ('claim_status', 'liaison->orchestrator', 'telemetry', '{"claim_id": "uuid", "ac_progress": {}, "eta_minutes": "integer|null"}'::jsonb, 'Mid-flight status'),
    ('protocol_pong', 'liaison->orchestrator', 'telemetry', '{"nonce": "string"}'::jsonb, 'Response to protocol_ping');

-- Sequence counter view (for efficient resumption on restart)
CREATE OR REPLACE VIEW roadmap.v_liaison_message_max_sequence AS
    SELECT
        agency_id,
        MAX(sequence) as max_sequence
    FROM roadmap.liaison_message
    GROUP BY agency_id;

-- Helper function: get next sequence for an agency
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_next_sequence(p_agency_id text)
RETURNS bigint AS $$
    SELECT COALESCE(MAX(sequence), 0) + 1
    FROM roadmap.liaison_message
    WHERE agency_id = p_agency_id;
$$ LANGUAGE SQL STABLE;

-- Helper function: acknowledge a message
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_ack_message(
    p_message_id uuid,
    p_outcome text,
    p_error text DEFAULT NULL
)
RETURNS TABLE(acked_at timestamptz, ack_outcome text, ack_error text) AS $$
    UPDATE roadmap.liaison_message
    SET
        acked_at = now(),
        ack_outcome = p_outcome,
        ack_error = p_error
    WHERE message_id = p_message_id
    RETURNING
        roadmap.liaison_message.acked_at,
        roadmap.liaison_message.ack_outcome,
        roadmap.liaison_message.ack_error;
$$ LANGUAGE SQL;

-- Notify function for LISTEN/NOTIFY integration
-- Triggers when a new message is created to notify listening processes
CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS TRIGGER AS $$
BEGIN
    -- Notify on the agency_id channel so liaisons can listen for their own messages
    PERFORM pg_notify(
        'liaison_message_' || NEW.agency_id,
        json_build_object(
            'message_id', NEW.message_id,
            'direction', NEW.direction,
            'kind', NEW.kind,
            'sequence', NEW.sequence
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for notifications
DROP TRIGGER IF EXISTS trig_liaison_notify_new_message ON roadmap.liaison_message;
CREATE TRIGGER trig_liaison_notify_new_message
    AFTER INSERT ON roadmap.liaison_message
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_liaison_notify_new_message();
