-- =============================================================================
-- 012-maturity-redesign.sql
-- Description: Replace JSONB maturity with single maturity_state + transition ledger
-- Date: 2026-04-09
-- Requires: 007-agent-security-roles.sql
--
-- Design rationale:
--   Production development is iterative: prototype → reassess → revise → expand.
--   Any complete component can be replaced via shorter AI iteration cycles.
--
--   The old JSONB maturity (e.g. {"Draft":"Mature","Review":"Active"}) stored
--   history inline and was derived FROM status — backwards. History belongs in
--   timestamped transition records with decision docs signed by lead agents.
--
--   The universal maturity lifecycle (New → Active → Mature → Obsolete) applies
--   within EVERY state. It repeats as proposals iterate through states.
--
--   With timestamped state+maturity transitions backed by decision records,
--   a single maturity_state TEXT column is sufficient for current state.
--   The combo of state + maturity_state change triggers gate notify.
--
-- This migration:
--   1. Adds maturity_state TEXT column (new|active|mature|obsolete)
--   2. Backfills from legacy JSONB maturity (one-time), then drops JSONB
--   3. Creates proposal_maturity_transitions ledger table
--   4. Remediate alien states: PROPOSAL→DRAFT, DEPLOYED→COMPLETE, DEFERRED→DRAFT
--   5. Fixes transition_reason values (manual/system → submit)
--   6. Drops broken trg_notify_maturity_change (references nonexistent maturity_level)
--   7. Adds trg_gate_ready trigger:
--      - Writes to proposal_maturity_transitions (ledger)
--      - Writes to proposal_event outbox (maturity_changed)
--      - Appends to proposal.audit
--      - Fires pg_notify('proposal_gate_ready') when maturity→mature
--   8. Adds 'decision:' context prefix convention
--   9. Fixes v_mature_queue (was broken: referenced non-existent columns)
--  10. Creates v_proposal_full — all sections + child tables as JSONB
--  11. Drops dead rfc_state column if it exists
--  12. Drops legacy JSONB maturity column
-- =============================================================================

BEGIN;

SET search_path TO roadmap, public;


-- ─── 1. Add maturity_state column ────────────────────────────────────────────

ALTER TABLE roadmap.proposal
    ADD COLUMN IF NOT EXISTS maturity_state text DEFAULT 'new' NOT NULL;

ALTER TABLE roadmap.proposal
    ADD CONSTRAINT proposal_maturity_state_check
    CHECK (maturity_state IN ('new', 'active', 'mature', 'obsolete'));

COMMENT ON COLUMN roadmap.proposal.maturity_state IS
    'Current maturity within the active state. Universal lifecycle: '
    'new → active → mature → obsolete. Repeats within each state as proposals '
    'iterate. When set to mature, triggers gate pipeline via trg_gate_ready. '
    'History is in proposal_maturity_transitions (timestamped, decision-backed).';


-- ─── 2. Backfill maturity_state from legacy JSONB, then drop JSONB ──────────
-- One-time backfill using the old JSONB map. After this, the JSONB column
-- is dropped — history lives in the transition ledger.

UPDATE roadmap.proposal p
SET maturity_state = COALESCE(
    CASE
        WHEN p.maturity ? p.status THEN
            CASE LOWER(COALESCE(p.maturity->>p.status, ''))
                WHEN 'mature'   THEN 'mature'
                WHEN 'active'   THEN 'active'
                WHEN 'obsolete' THEN 'obsolete'
                ELSE 'new'
            END
        ELSE 'new'
    END,
    'new'
)
WHERE maturity_state = 'new';


-- ─── 3. Create proposal_maturity_transitions ledger ─────────────────────────
-- Timestamped history of every maturity change, backed by decision record.
-- Mirrors proposal_state_transitions pattern but for maturity lifecycle.

CREATE TABLE IF NOT EXISTS roadmap.proposal_maturity_transitions (
    id                int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id       int8        NOT NULL,
    from_maturity     text        NOT NULL,
    to_maturity       text        NOT NULL,
    transition_reason text        NOT NULL,  -- 'submit' | 'decision' | 'system'
    transitioned_by   text        NOT NULL,
    decision_notes    text        NULL,      -- required for 'decision' transitions
    created_at        timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_maturity_trans_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_maturity_trans_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_maturity_trans_from_check    CHECK (
        from_maturity IN ('new', 'active', 'mature', 'obsolete')),
    CONSTRAINT proposal_maturity_trans_to_check      CHECK (
        to_maturity IN ('new', 'active', 'mature', 'obsolete')),
    CONSTRAINT proposal_maturity_trans_reason_check  CHECK (
        transition_reason IN ('submit', 'decision', 'system'))
);

CREATE INDEX idx_maturity_trans_proposal ON roadmap.proposal_maturity_transitions (proposal_id);
CREATE INDEX idx_maturity_trans_at       ON roadmap.proposal_maturity_transitions (created_at DESC);
CREATE INDEX idx_maturity_trans_to       ON roadmap.proposal_maturity_transitions (to_maturity);

COMMENT ON TABLE roadmap.proposal_maturity_transitions IS
    'Timestamped ledger of maturity lifecycle changes within each state. '
    'Every transition is backed by agent identity and optional decision notes. '
    'This replaces the old JSONB maturity map — history via transitions, not inline.';


-- ─── 4. Remediate alien states ──────────────────────────────────────────────
-- PROPOSAL → DRAFT, DEPLOYED → COMPLETE, DEFERRED → DRAFT

UPDATE roadmap.proposal SET status = 'Draft'     WHERE status = 'PROPOSAL';
UPDATE roadmap.proposal SET status = 'Complete'   WHERE status = 'DEPLOYED';
UPDATE roadmap.proposal SET status = 'Draft'      WHERE status = 'DEFERRED';

UPDATE roadmap.proposal_state_transitions SET from_state = 'Draft'    WHERE from_state = 'PROPOSAL';
UPDATE roadmap.proposal_state_transitions SET to_state   = 'Draft'    WHERE to_state   = 'PROPOSAL';
UPDATE roadmap.proposal_state_transitions SET from_state = 'Complete' WHERE from_state = 'DEPLOYED';
UPDATE roadmap.proposal_state_transitions SET to_state   = 'Complete' WHERE to_state   = 'DEPLOYED';
UPDATE roadmap.proposal_state_transitions SET from_state = 'Draft'    WHERE from_state = 'DEFERRED';
UPDATE roadmap.proposal_state_transitions SET to_state   = 'Draft'    WHERE to_state   = 'DEFERRED';


-- ─── 5. Fix transition_reason values ────────────────────────────────────────

UPDATE roadmap.proposal_state_transitions
SET transition_reason = 'submit'
WHERE transition_reason IN ('manual', 'system');


-- ─── 6. Drop broken trg_notify_maturity_change ──────────────────────────────
-- Migration 006 created this trigger referencing maturity_level column
-- which doesn't exist. Drop it; we replace with trg_gate_ready below.

DROP TRIGGER IF EXISTS trg_notify_maturity_change ON roadmap.proposal;
DROP FUNCTION IF EXISTS roadmap.fn_notify_maturity_change();


-- ─── 7. Add trg_gate_ready trigger ──────────────────────────────────────────
-- Full event chain on maturity change:
--   1. Append to proposal.audit (same pattern as fn_log_proposal_state_change)
--   2. Insert into proposal_maturity_transitions (ledger)
--   3. Insert into proposal_event outbox (maturity_changed)
--   4. When maturity → 'mature': pg_notify('proposal_gate_ready')
--
-- Decision transitions (maturity → mature) require decision_notes.
-- The application layer (prop_set_maturity handler) enforces this;
-- the trigger stores whatever it receives.

CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_agent text;
BEGIN
    -- Only fire when maturity_state actually changes
    IF NEW.maturity_state IS DISTINCT FROM OLD.maturity_state THEN
        v_agent := COALESCE(current_setting('app.agent_identity', true), 'system');

        -- 1. Append to audit
        NEW.audit := NEW.audit || jsonb_build_object(
            'TS',       to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'Agent',    v_agent,
            'Activity', 'MaturityChange',
            'From',     OLD.maturity_state,
            'To',       NEW.maturity_state
        );

        -- 2. Maturity transition ledger
        INSERT INTO roadmap.proposal_maturity_transitions
		    (proposal_id, from_maturity, to_maturity, transition_reason, transitioned_by)
		VALUES (NEW.id, OLD.maturity_state, NEW.maturity_state, 'submit', v_agent);

        -- 3. Outbox event
        INSERT INTO roadmap.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.id,
            'maturity_changed',
            jsonb_build_object(
                'from',  OLD.maturity_state,
                'to',    NEW.maturity_state,
                'stage', NEW.status,
                'agent', v_agent,
                'ts',    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        );

        -- 4. Gate notify when reaching 'mature'
        IF NEW.maturity_state = 'mature' THEN
            PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
                'proposal_id',    NEW.id,
                'display_id',     NEW.display_id,
                'from_maturity',  OLD.maturity_state,
                'to_maturity',    NEW.maturity_state,
                'stage',          NEW.status,
                'ts',             to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )::text);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gate_ready
    BEFORE UPDATE OF maturity_state ON roadmap.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_notify_gate_ready();


-- ─── 8. 'decision:' context prefix ──────────────────────────────────────────
-- Convention: gate transitions use 'decision: <notes>' as transition_reason.
-- The prop_transition handler enforces non-empty notes for gate transitions.
-- The prop_set_maturity handler enforces non-empty notes when setting mature.


-- ─── 9. Fix v_mature_queue view ─────────────────────────────────────────────

DROP VIEW IF EXISTS roadmap.v_mature_queue;

CREATE OR REPLACE VIEW roadmap.v_mature_queue AS
SELECT
    p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.maturity_state,
    p.priority,
    p.created_at,
    COALESCE(bc.blocker_count, 0) AS blocks_count,
    COALESCE(dc.dep_count, 0) AS depends_on_count
FROM roadmap.proposal p
LEFT JOIN (
    SELECT from_proposal_id AS proposal_id, COUNT(*) AS blocker_count
    FROM roadmap.proposal_dependencies
    WHERE resolved = false AND dependency_type = 'blocks'
    GROUP BY from_proposal_id
) bc ON bc.proposal_id = p.id
LEFT JOIN (
    SELECT to_proposal_id AS proposal_id, COUNT(*) AS dep_count
    FROM roadmap.proposal_dependencies
    WHERE resolved = false AND dependency_type = 'blocks'
    GROUP BY to_proposal_id
) dc ON dc.proposal_id = p.id
WHERE p.maturity_state = 'mature'
ORDER BY bc.blocker_count DESC NULLS LAST, p.created_at ASC;

COMMENT ON VIEW roadmap.v_mature_queue IS
    'Proposals at mature maturity_state, ready for gate evaluation. '
    'Ordered by how many others they block (most impactful first).';


-- ─── 10. Create v_proposal_full view ────────────────────────────────────────

DROP VIEW IF EXISTS roadmap.v_proposal_full;

CREATE OR REPLACE VIEW roadmap.v_proposal_full AS
SELECT
    p.id,
    p.display_id,
    p.parent_id,
    p.type,
    p.status,
    p.maturity_state,
    p.title,
    p.summary,
    p.motivation,
    p.design,
    p.drawbacks,
    p.alternatives,
    p.dependency,
    p.priority,
    p.tags,
    p.audit,
    p.created_at,
    p.modified_at,
    COALESCE(dep.deps, '[]'::jsonb) AS dependencies,
    COALESCE(ac.criteria, '[]'::jsonb) AS acceptance_criteria,
    dec.latest_decision,
    dec.decision_at,
    lease.leased_by,
    lease.lease_expires,
    wf.workflow_name,
    wf.current_stage
FROM roadmap.proposal p
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
        'to_display_id', pd.display_id,
        'dependency_type', d.dependency_type,
        'resolved', d.resolved
    )) AS deps
    FROM roadmap.proposal_dependencies d
    JOIN roadmap.proposal pd ON pd.id = d.to_proposal_id
    WHERE d.from_proposal_id = p.id
) dep ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
        'item_number', ac.item_number,
        'criterion_text', ac.criterion_text,
        'status', ac.status,
        'verified_by', ac.verified_by
    ) ORDER BY ac.item_number) AS criteria
    FROM roadmap.proposal_acceptance_criteria ac
    WHERE ac.proposal_id = p.id
) ac ON true
LEFT JOIN LATERAL (
    SELECT pd.decision AS latest_decision, pd.decided_at AS decision_at
    FROM roadmap.proposal_decision pd
    WHERE pd.proposal_id = p.id
    ORDER BY pd.decided_at DESC
    LIMIT 1
) dec ON true
LEFT JOIN LATERAL (
    SELECT pl.agent_identity AS leased_by, pl.expires_at AS lease_expires
    FROM roadmap.proposal_lease pl
    WHERE pl.proposal_id = p.id AND pl.released_at IS NULL
    ORDER BY pl.claimed_at DESC
    LIMIT 1
) lease ON true
LEFT JOIN LATERAL (
    SELECT ptc.workflow_name, w.current_stage
    FROM roadmap.workflows w
    JOIN roadmap.proposal_type_config ptc ON ptc.workflow_name = w.workflow_name
    WHERE w.proposal_id = p.id
    LIMIT 1
) wf ON true;

COMMENT ON VIEW roadmap.v_proposal_full IS
    'Complete proposal with all child tables as JSONB. '
    'Used by MCP tools for full proposal rendering.';


-- ─── 11. Drop dead rfc_state column if it exists ────────────────────────────

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name = 'proposal'
          AND column_name = 'rfc_state'
    ) THEN
        ALTER TABLE roadmap.proposal DROP COLUMN rfc_state;
    END IF;
END $$;


-- ─── 12. Drop legacy JSONB maturity column ──────────────────────────────────
-- History now lives in proposal_maturity_transitions (timestamped, decision-backed).
-- Current state lives in maturity_state TEXT.
-- The JSONB map is no longer needed.

ALTER TABLE roadmap.proposal DROP COLUMN IF EXISTS maturity;


COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'roadmap' AND table_name = 'proposal'
--     AND column_name IN ('maturity_state', 'maturity')
--   ORDER BY ordinal_position;
--
-- SELECT count(*) FILTER (WHERE maturity_state = 'new')     AS new,
--        count(*) FILTER (WHERE maturity_state = 'active')   AS active,
--        count(*) FILTER (WHERE maturity_state = 'mature')   AS mature,
--        count(*) FILTER (WHERE maturity_state = 'obsolete') AS obsolete
-- FROM roadmap.proposal;
--
-- SELECT * FROM roadmap.v_mature_queue LIMIT 5;
-- SELECT display_id, title, status, maturity_state FROM roadmap.v_proposal_full LIMIT 5;
--
-- -- Verify maturity transition ledger
-- SELECT pmt.display_id, pmt.from_maturity, pmt.to_maturity,
--        pmt.transitioned_by, pmt.decision_notes, pmt.created_at
-- FROM roadmap.proposal_maturity_transitions pmt
-- JOIN roadmap.proposal p ON p.id = pmt.proposal_id
-- ORDER BY pmt.created_at DESC LIMIT 10;
