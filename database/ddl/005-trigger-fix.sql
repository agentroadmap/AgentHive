-- 005-trigger-fix.sql
-- Fix: state transition trigger used 'manual' which violates the
-- transition_reason CHECK constraint (only allows: mature, decision,
-- iteration, depend, discard, rejected, research, division, submit).
--
-- Changes default reason from 'manual' to 'mature' and handles NULL
-- OLD.status (new proposals) by using COALESCE.
--
-- Applied: 2026-04-04 22:15 EDT
-- Issue: Any status change on proposals failed to create audit log entries
-- because 'manual' is not a valid reason code.

CREATE OR REPLACE FUNCTION log_proposal_state_change() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM proposal_valid_transitions
        WHERE UPPER(from_state) = UPPER(COALESCE(OLD.status, 'NEW'))
          AND UPPER(to_state) = UPPER(NEW.status)
    ) OR OLD.status IS NULL THEN
        INSERT INTO proposal_state_transitions (
            proposal_id, from_state, to_state, transition_reason, transitioned_by, notes
        ) VALUES (
            NEW.id,
            COALESCE(OLD.status, 'NEW'),
            NEW.status,
            'mature',
            NULL,
            'Status changed from ' || COALESCE(OLD.status, 'NEW') || ' to ' || NEW.status
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Verify:
-- UPDATE proposal SET status = 'REVIEW', updated_at = now() WHERE display_id = 'P001' RETURNING display_id, status;
-- SELECT from_state, to_state, transition_reason FROM proposal_state_transitions ORDER BY id DESC LIMIT 1;
