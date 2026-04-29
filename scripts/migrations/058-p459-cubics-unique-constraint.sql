/**
 * P459: Unique constraint on roadmap.cubics to prevent concurrent same-role races
 *
 * AC#102: UK(agent_identity, phase, status) prevents two cubics with same agent
 *         in the same phase at the same lifecycle status.
 *
 * Uses a partial unique index (WHERE agent_identity IS NOT NULL) so that cubics
 * created without a registered agent_identity (ad-hoc or anonymous) never conflict
 * with each other — they are identified only by cubic_id.
 *
 * The ON CONFLICT upsert in cubic_create uses this index to detect races:
 * concurrent creates for the same agent+phase return the existing cubic_id instead
 * of failing with a duplicate key error (AC#103).
 */

BEGIN;

-- Partial unique index: registered-agent cubics only, all statuses
-- This allows an agent to have at most one cubic per (phase, status) combination.
-- E.g. a skeptic can't have two 'idle' cubics in the 'design' phase simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS uk_cubics_agent_phase_status
    ON roadmap.cubics (agent_identity, phase, status)
    WHERE agent_identity IS NOT NULL;

COMMENT ON INDEX roadmap.uk_cubics_agent_phase_status
    IS 'P459: Prevents concurrent same-role cubic races for registered agents. '
       'ad-hoc (NULL agent_identity) cubics are excluded.';

COMMIT;
