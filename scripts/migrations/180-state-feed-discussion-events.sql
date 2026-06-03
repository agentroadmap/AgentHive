-- 180-state-feed-discussion-events.sql
--
-- Forward high-signal proposal_discussions inserts to the state feed via
-- proposal_event + roadmap_events NOTIFY. Closes the visibility gap where
-- substantive reviews (gate decisions, concerns, ship-verification) landed
-- in the DB but never reached Discord/operator feed.
--
-- Companion code change: scripts/state-feed-listener.ts handles event_type
-- 'discussion_posted'. The existing trg_notify_event AFTER INSERT trigger
-- on proposal_event handles the actual pg_notify; this migration only
-- emits the event row.
--
-- High-signal context_prefix values forwarded:
--   concern:, feedback:, gate-decision:, critical:, security:, ship-verification:
-- Suppressed: general:, arch:, team:, poc:, handoff: (chatter/internal scratch)
--
-- Reversible: DROP TRIGGER + DROP FUNCTION + restore prior CHECK constraint.

BEGIN;

-- 1. Extend proposal_event_type_check to allow the new event_type.
ALTER TABLE roadmap_proposal.proposal_event
    DROP CONSTRAINT IF EXISTS proposal_event_type_check;

ALTER TABLE roadmap_proposal.proposal_event
    ADD CONSTRAINT proposal_event_type_check CHECK (event_type = ANY (ARRAY[
        'status_changed'::text,
        'decision_made'::text,
        'lease_claimed'::text,
        'lease_released'::text,
        'dependency_added'::text,
        'dependency_resolved'::text,
        'ac_updated'::text,
        'review_submitted'::text,
        'maturity_changed'::text,
        'milestone_achieved'::text,
        'proposal_created'::text,
        'gate_dispatched'::text,
        'gate_advanced'::text,
        'gate_held'::text,
        'gate_failed'::text,
        'agent_dispatched'::text,
        'agent_completed'::text,
        'agent_failed'::text,
        'agent_sos'::text,
        'agent_ask'::text,
        'agent_decision'::text,
        'squad_dispatched'::text,
        'frontier_audit_flag'::text,
        'frontier_audit_pause'::text,
        'frontier_audit_critical'::text,
        'cross_dep_orphan_detected'::text,
        'cross_dep_cycle_detected'::text,
        'discussion_posted'::text
    ]));

-- 2. Trigger function: emit proposal_event row for high-signal discussions.
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_emit_discussion_event()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.context_prefix IN (
        'concern:',
        'feedback:',
        'gate-decision:',
        'critical:',
        'security:',
        'ship-verification:'
    ) THEN
        INSERT INTO roadmap_proposal.proposal_event
            (proposal_id, event_type, payload, project_id)
        VALUES (
            NEW.proposal_id,
            'discussion_posted',
            jsonb_build_object(
                'discussion_id', NEW.id,
                'author_identity', NEW.author_identity,
                'context_prefix', NEW.context_prefix,
                'body_preview', LEFT(NEW.body, 240)
            ),
            NEW.project_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach the trigger.
DROP TRIGGER IF EXISTS trg_emit_discussion_event
    ON roadmap_proposal.proposal_discussions;

CREATE TRIGGER trg_emit_discussion_event
    AFTER INSERT ON roadmap_proposal.proposal_discussions
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_proposal.fn_emit_discussion_event();

COMMIT;
