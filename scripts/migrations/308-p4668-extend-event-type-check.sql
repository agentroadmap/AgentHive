-- ============================================================================
-- Migration 308 — P4668 AC-8: Extend proposal_event.event_type CHECK
-- ----------------------------------------------------------------------------
-- Adds six new event_type values needed by the P4668 dual-write shim:
--   break_glass              — operator emergency override event
--   maturity_reset_on_status_change — fn_sync_proposal_maturity resets
--   compensating_correction  — correction to a prior incorrect event
--   federation_sync          — cross-tenant sync (AC-36 HIGH-RISK path)
--   gate_pause_demotion      — premature-gate demotion (AC-35)
--   maturity_set             — direct setMaturity() calls
--
-- Strategy: DROP the old constraint, ADD new one with extended value list.
-- The DROP+ADD is done in a single transaction on a named constraint.
--
-- ORDERING: Can run after mig 306. mig 307 does not affect constraints.
-- ROLLBACK:  scripts/migrations/rollback/308-p4668-extend-event-type-check.rollback.sql
-- ============================================================================

BEGIN;

-- Drop old CHECKs (names from live schema: proposal_event_type_check is the
-- baseline name; proposal_event_event_type_check may exist if this migration
-- has been partially applied and re-run)
ALTER TABLE roadmap_proposal.proposal_event
    DROP CONSTRAINT IF EXISTS proposal_event_type_check;
ALTER TABLE roadmap_proposal.proposal_event
    DROP CONSTRAINT IF EXISTS proposal_event_event_type_check;

-- Re-add with extended vocabulary (canonical name)
ALTER TABLE roadmap_proposal.proposal_event
    ADD CONSTRAINT proposal_event_event_type_check CHECK (event_type = ANY (ARRAY[
        -- Original 28 values (preserved exactly)
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
        'discussion_posted',
        -- P4668 additions
        'break_glass',
        'maturity_reset_on_status_change',
        'compensating_correction',
        'federation_sync',
        'gate_pause_demotion',
        'maturity_set'
    ]));

COMMIT;
