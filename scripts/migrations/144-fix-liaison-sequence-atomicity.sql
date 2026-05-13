-- Migration 144: Fix fn_liaison_next_sequence race condition
--
-- Problem: fn_liaison_next_sequence used COALESCE(MAX(sequence),0)+1 which is
-- non-atomic. Under concurrent dispatch bursts (orchestrator restart re-queuing
-- 10+ messages at once), multiple callers read the same MAX and get the same
-- sequence number. This causes ON CONFLICT DO UPDATE in storeMessage to overwrite
-- the existing row's message_id — the trigger had already fired pg_notify with the
-- old UUID, so when the hub tries to ack it, fn_liaison_ack_message returns 0 rows
-- ("Failed to acknowledge message"). The messages stay unacked forever, keeping
-- every agency pinned at max_in_flight and blocking all further dispatches.
--
-- Fix 1: Replace fn_liaison_next_sequence with an atomic UPDATE-based counter
-- using a dedicated liaison_sequence table. The INSERT...ON CONFLICT DO UPDATE
-- pattern is lock-based and serialises concurrent callers at the DB level.
--
-- Fix 2: Remove `message_id = EXCLUDED.message_id` from the storeMessage
-- ON CONFLICT clause. Message IDs must be immutable once the INSERT trigger has
-- fired pg_notify — overwriting them creates a window where the ack fails because
-- the notified UUID no longer matches the row.
-- NOTE: Fix 2 is applied in liaison-message-service.ts (application code), not SQL.

-- ── Step 1: create liaison_sequence table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.liaison_sequence (
    agency_id TEXT    PRIMARY KEY,
    last_seq  BIGINT  NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.liaison_sequence IS
    'Per-agency atomic sequence counters for liaison_message.sequence. '
    'Written by fn_liaison_next_sequence; replaces the racy MAX(sequence)+1 approach.';

-- ── Step 2: backfill from existing liaison_message rows ──────────────────────

INSERT INTO roadmap.liaison_sequence (agency_id, last_seq)
SELECT agency_id, COALESCE(MAX(sequence), 0)
FROM roadmap.liaison_message
GROUP BY agency_id
ON CONFLICT (agency_id) DO UPDATE
    SET last_seq = GREATEST(roadmap.liaison_sequence.last_seq, EXCLUDED.last_seq);

-- ── Step 3: replace fn_liaison_next_sequence with atomic version ──────────────

CREATE OR REPLACE FUNCTION roadmap.fn_liaison_next_sequence(p_agency_id TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_seq BIGINT;
BEGIN
    INSERT INTO roadmap.liaison_sequence (agency_id, last_seq, updated_at)
    VALUES (p_agency_id, 1, now())
    ON CONFLICT (agency_id) DO UPDATE
        SET last_seq   = roadmap.liaison_sequence.last_seq + 1,
            updated_at = now()
    RETURNING last_seq INTO v_seq;
    RETURN v_seq;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_liaison_next_sequence(TEXT) IS
    'Atomically allocate the next sequence number for an agency. '
    'Uses INSERT...ON CONFLICT DO UPDATE to serialise concurrent callers. '
    'Replaces the racy COALESCE(MAX(sequence),0)+1 implementation (migration 144).';
