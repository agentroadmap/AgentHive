-- ============================================================================
-- ROLLBACK: Migration 308 — extend proposal_event.event_type CHECK
-- ============================================================================
-- WARNING: If any proposal_event rows have already been inserted with the
-- new event_type values ('break_glass', 'maturity_reset_on_status_change',
-- 'compensating_correction', 'federation_sync', 'gate_pause_demotion',
-- 'maturity_set'), this rollback will fail until those rows are deleted or
-- event_type is updated.
-- ============================================================================

BEGIN;

ALTER TABLE roadmap_proposal.proposal_event
    DROP CONSTRAINT IF EXISTS proposal_event_event_type_check;

ALTER TABLE roadmap_proposal.proposal_event
    ADD CONSTRAINT proposal_event_type_check CHECK (event_type = ANY (ARRAY[
        'status_changed',
        'decision_made',
        'lease_claimed',
        'lease_released',
        'dependency_added',
        'dependency_resolved',
        'ac_updated',
        'review_submitted',
        'maturity_changed',
        'milestone_achieved',
        'proposal_created',
        'gate_dispatched',
        'gate_advanced',
        'gate_held',
        'gate_failed',
        'agent_dispatched',
        'agent_completed',
        'agent_failed',
        'agent_sos',
        'agent_ask',
        'agent_decision',
        'squad_dispatched',
        'frontier_audit_flag',
        'frontier_audit_pause',
        'frontier_audit_critical',
        'cross_dep_orphan_detected',
        'cross_dep_cycle_detected',
        'discussion_posted'
    ]));

COMMIT;
