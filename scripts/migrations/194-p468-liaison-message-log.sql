-- Migration 194: P468 — Two-way orchestrator↔liaison messaging protocol
--
-- Documents the schema that was created as part of the P594 agency schema work
-- (migrations 061-062). This migration is idempotent and safe to re-run.
--
-- DB objects owned by this proposal:
--   roadmap.liaison_message          — durable append-only message log
--   roadmap.liaison_sequence         — per-agency advisory-locked sequence counters
--   roadmap.fn_liaison_next_sequence — monotonic per-agency sequence assignment
--   roadmap.fn_liaison_ack_message   — COALESCE-guarded first-write-wins ack
--   roadmap.fn_liaison_notify_new_message — NOTIFY trigger function
--   roadmap.trig_liaison_notify_new_message — trigger on liaison_message

-- ─── Sequence counter table (idempotent) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.liaison_sequence (
    agency_id   TEXT        NOT NULL PRIMARY KEY
                            REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    last_seq    BIGINT      NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE roadmap.liaison_sequence IS
    'P468: per-agency monotonic sequence counter for liaison_message rows. '
    'Updated under advisory lock by fn_liaison_next_sequence().';

-- ─── Message log table (idempotent) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.liaison_message (
    message_id      UUID        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_id       TEXT        NOT NULL
                                REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    sequence        BIGINT      NOT NULL,
    direction       TEXT        NOT NULL
                                CHECK (direction IN ('orchestrator->liaison', 'liaison->orchestrator')),
    kind            TEXT        NOT NULL,
    correlation_id  UUID        NOT NULL DEFAULT gen_random_uuid(),
    payload         JSONB       NOT NULL DEFAULT '{}',
    signed_at       TIMESTAMPTZ NOT NULL,
    signature       TEXT        NOT NULL,
    acked_at        TIMESTAMPTZ,
    ack_outcome     TEXT        CHECK (ack_outcome IN ('ok', 'reject', 'noop')),
    ack_error       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ledger_id       BIGINT,
    host_id         TEXT,

    CONSTRAINT uq_liaison_message_agency_seq UNIQUE (agency_id, sequence)
);

COMMENT ON TABLE roadmap.liaison_message IS
    'P468: durable append-only message log for the orchestrator↔liaison '
    'control + telemetry planes. Idempotent by (agency_id, sequence). '
    'Messages are signed (HMAC-SHA256) and replay-protected (5-min signed_at window). '
    'Replay from log is the recovery path after network partition.';

COMMENT ON COLUMN roadmap.liaison_message.sequence IS
    'Monotonically increasing per-agency sequence, assigned by fn_liaison_next_sequence() '
    'under pg_advisory_xact_lock. Used by OutOfOrderBuffer for gap detection.';

COMMENT ON COLUMN roadmap.liaison_message.host_id IS
    'P922: routing field — used to construct the per-host NOTIFY channel '
    'a2a_msg_<host_id> for multi-host deployments.';

-- ─── Indexes (idempotent) ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_liaison_message_agency_seq
    ON roadmap.liaison_message (agency_id, sequence);

CREATE INDEX IF NOT EXISTS idx_liaison_message_agency_unacked
    ON roadmap.liaison_message (agency_id, created_at)
    WHERE acked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_liaison_message_correlation
    ON roadmap.liaison_message (correlation_id);

-- ─── Sequence function (idempotent) ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_liaison_next_sequence(p_agency_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_next BIGINT;
BEGIN
    -- Advisory lock scoped to this agency within the transaction
    PERFORM pg_advisory_xact_lock(hashtext('liaison_seq:' || p_agency_id));

    INSERT INTO roadmap.liaison_sequence (agency_id, last_seq)
    VALUES (p_agency_id, 1)
    ON CONFLICT (agency_id) DO UPDATE
        SET last_seq   = roadmap.liaison_sequence.last_seq + 1,
            updated_at = NOW()
    RETURNING last_seq INTO v_next;

    RETURN v_next;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_liaison_next_sequence(TEXT) IS
    'P468: advisory-locked monotonic sequence assignment per agency. '
    'Safe under concurrent writers — pg_advisory_xact_lock serialises increments.';

-- ─── Ack function (idempotent) ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_liaison_ack_message(
    p_message_id  UUID,
    p_outcome     TEXT,
    p_error       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE roadmap.liaison_message
       SET acked_at    = COALESCE(acked_at, NOW()),
           ack_outcome = p_outcome,
           ack_error   = p_error
     WHERE message_id = p_message_id;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_liaison_ack_message(UUID, TEXT, TEXT) IS
    'P468: COALESCE-guarded ack — acked_at is first-write-wins; '
    'ack_outcome and ack_error are overwritten on re-ack (for correction).';

-- ─── NOTIFY trigger (idempotent) ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_liaison_notify_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Lightweight envelope — receiver fetches full row from DB
    PERFORM pg_notify(
        'a2a_msg_' || NEW.agency_id,
        json_build_object(
            'message_id', NEW.message_id,
            'agency_id',  NEW.agency_id,
            'sequence',   NEW.sequence,
            'kind',       NEW.kind,
            'direction',  NEW.direction,
            'host_id',    NEW.host_id
        )::text
    );
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_liaison_notify_new_message() IS
    'P468: AFTER INSERT trigger — fires pg_notify on a2a_msg_<agency_id> '
    'with a lightweight envelope. Full message row fetched by receiver.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trig_liaison_notify_new_message'
           AND tgrelid = 'roadmap.liaison_message'::regclass
    ) THEN
        CREATE TRIGGER trig_liaison_notify_new_message
            AFTER INSERT ON roadmap.liaison_message
            FOR EACH ROW EXECUTE FUNCTION roadmap.fn_liaison_notify_new_message();
    END IF;
END;
$$;
