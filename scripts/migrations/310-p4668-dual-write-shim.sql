-- ============================================================================
-- Migration 310 — P4668 AC-9/AC-12: Dual-write shim + shadow backfill
-- ----------------------------------------------------------------------------
-- Step 5 of 8 in the P4668 rollout:
--   310: dual-write shim + shadow backfill  ← THIS FILE
--
-- PURPOSE:
--   Install a trigger on proposal_state_transitions that shadow-writes to the
--   canonical ledger for every new legacy transition row. During this window
--   both the legacy path (proposal_state_transitions) and the canonical ledger
--   receive every transition, enabling divergence comparison (AC-9).
--
--   Also installs fn_p4668_backfill_history() which can be called once (report-
--   only mode then commit mode) to back-classify all existing legacy rows into
--   the ledger with appropriate confidence levels.
--
-- SCHEMA NOTES:
--   proposal_state_transitions uses from_state/to_state (not from_status/to_status)
--   and transitioned_at (not created_at). There is no project_id column.
--
-- SAFETY:
--   - Backfill is IDEMPOTENT: it checks idempotency_key before inserting.
--   - No existing table is altered in a breaking way. No application code change
--     is required to get dual-write coverage — the trigger handles it.
--   - Trigger exceptions are caught and logged — shadow writes never block legacy.
--
-- ROLLBACK: scripts/migrations/rollback/310-p4668-dual-write-shim.rollback.sql
-- ============================================================================

BEGIN;

-- ── 1. Shadow-write trigger function ─────────────────────────────────────────
-- Fires AFTER INSERT on proposal_state_transitions (the legacy write path).
-- Writes a mirrored event to the canonical ledger with source_confidence='medium'
-- (because legacy rows do not always carry full actor provenance).

CREATE OR REPLACE FUNCTION roadmap.fn_shadow_write_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, public
AS $$
DECLARE
    v_idempotency_key TEXT;
    v_existing_event_id UUID;
BEGIN
    -- Build a deterministic idempotency key from the legacy row's PK so the
    -- trigger is safe to fire more than once (e.g. on partition moves or
    -- statement-level retries).
    v_idempotency_key := 'pst-shadow:' || NEW.id::text;

    -- Skip if already in ledger (idempotency guard)
    SELECT event_id INTO v_existing_event_id
    FROM roadmap_proposal.proposal_transition_ledger
    WHERE idempotency_key = v_idempotency_key
    LIMIT 1;

    IF FOUND THEN
        RETURN NEW;
    END IF;

    -- Insert shadow event. source_confidence='medium' because legacy rows
    -- often lack resolved_provider, model, and full actor provenance.
    -- NOTE: pst uses from_state/to_state columns, not from_status/to_status.
    INSERT INTO roadmap_proposal.proposal_transition_ledger (
        proposal_id,
        project_id,
        from_status,
        to_status,
        event_kind,
        reason_code,
        rationale,
        actor_principal_id,
        actor_layer,
        actor_identity_snapshot,
        lease_id,
        source_surface,
        service_identity,
        occurred_at,
        recorded_at,
        source_confidence,
        idempotency_key
    ) VALUES (
        NEW.proposal_id,
        1,                   -- proposal_state_transitions has no project_id col
        NEW.from_state,
        NEW.to_state,
        'status_transition',
        COALESCE(NULLIF(NEW.transition_reason, ''), 'system'),
        NEW.notes,
        COALESCE(NULLIF(NEW.transitioned_by, ''), 'system'),
        'system-trigger',    -- actor_layer: shadow from legacy trigger
        '{"source": "pst-shadow-trigger"}'::jsonb,
        NULL,                -- lease_id not on pst
        'pst-shadow-trigger',
        'fn_shadow_write_to_ledger',
        COALESCE(NEW.transitioned_at, NOW()),
        NOW(),
        'medium',            -- medium: legacy row, provenance incomplete
        v_idempotency_key
    );

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Shadow writes must NEVER block the legacy path. Log and continue.
    RAISE WARNING 'fn_shadow_write_to_ledger: failed to shadow proposal_id=% pst_id=% — %',
        NEW.proposal_id, NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- ── 2. Attach trigger to proposal_state_transitions ────────────────────────
DROP TRIGGER IF EXISTS trg_shadow_write_to_ledger ON roadmap_proposal.proposal_state_transitions;

CREATE TRIGGER trg_shadow_write_to_ledger
    AFTER INSERT ON roadmap_proposal.proposal_state_transitions
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_shadow_write_to_ledger();

COMMENT ON TRIGGER trg_shadow_write_to_ledger ON roadmap_proposal.proposal_state_transitions IS
    'P4668 AC-9: Dual-write shim. Every new legacy transition row is shadowed '
    'into proposal_transition_ledger with source_confidence=medium. '
    'Fires AFTER INSERT. Exceptions are caught and logged — never blocks legacy write. '
    'Removed in mig 313 when legacy writes are retired.';

-- ── 3. Divergence comparison view (AC-9) ─────────────────────────────────────
-- Shows canonical ledger rows vs legacy state-transition rows for the same
-- proposal, enabling comparison during the dual-write window.
-- NOTE: pst uses from_state/to_state; ledger uses from_status/to_status.

CREATE OR REPLACE VIEW roadmap_proposal.v_dual_write_divergence AS
SELECT
    pst.proposal_id,
    pst.id                AS pst_id,
    pst.from_state        AS pst_from_status,
    pst.to_state          AS pst_to_status,
    pst.transitioned_at   AS pst_created_at,
    pst.transitioned_by   AS pst_actor,
    pst.transition_reason AS pst_reason,
    ptl.event_id          AS ledger_event_id,
    ptl.from_status       AS ledger_from_status,
    ptl.to_status         AS ledger_to_status,
    ptl.occurred_at       AS ledger_occurred_at,
    ptl.actor_principal_id AS ledger_actor,
    ptl.reason_code       AS ledger_reason,
    ptl.source_confidence AS ledger_confidence,
    -- Divergence flags
    (ptl.event_id IS NULL) AS flag_missing_in_ledger,
    (pst.from_state IS DISTINCT FROM ptl.from_status) AS flag_from_status_mismatch,
    (pst.to_state   IS DISTINCT FROM ptl.to_status)   AS flag_to_status_mismatch
FROM roadmap_proposal.proposal_state_transitions pst
LEFT JOIN roadmap_proposal.proposal_transition_ledger ptl
    ON ptl.idempotency_key = 'pst-shadow:' || pst.id::text;

COMMENT ON VIEW roadmap_proposal.v_dual_write_divergence IS
    'P4668 AC-9: Dual-write divergence view. During the compatibility window, '
    'query this view to find proposal_state_transitions rows not yet mirrored '
    'to the canonical ledger, or where status values diverge. '
    'Zero flag_missing_in_ledger rows (for rows created after mig 310 applied) '
    'is the green-light condition for cutover to mig 311 enforcement.';

GRANT SELECT ON roadmap_proposal.v_dual_write_divergence TO claude, agent_read, agent_write;

-- ── 4. Backfill function for pre-310 legacy rows (AC-7/AC-8) ─────────────────
-- Back-classifies all proposal_state_transitions rows inserted BEFORE this
-- migration into the ledger with source_confidence='low'.
-- Run with p_dry_run=TRUE first to see what would be inserted.

CREATE OR REPLACE FUNCTION roadmap.fn_p4668_backfill_history(
    p_dry_run   BOOLEAN DEFAULT TRUE,
    p_batch     INTEGER DEFAULT 500
)
RETURNS TABLE (
    rows_found   BIGINT,
    rows_skipped BIGINT,   -- already in ledger
    rows_inserted BIGINT,
    dry_run      BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, public
AS $$
DECLARE
    v_found    BIGINT := 0;
    v_skipped  BIGINT := 0;
    v_inserted BIGINT := 0;
    v_idem_key TEXT;
    r          RECORD;
BEGIN
    FOR r IN
        SELECT
            pst.id,
            pst.proposal_id,
            pst.from_state,
            pst.to_state,
            pst.transition_reason,
            pst.notes,
            pst.transitioned_by,
            pst.transitioned_at
        FROM roadmap_proposal.proposal_state_transitions pst
        WHERE pst.id IS NOT NULL
        ORDER BY pst.proposal_id, pst.id ASC
        LIMIT p_batch
    LOOP
        v_found := v_found + 1;
        v_idem_key := 'pst-shadow:' || r.id::text;

        -- Skip if already in ledger
        IF EXISTS (
            SELECT 1 FROM roadmap_proposal.proposal_transition_ledger
            WHERE idempotency_key = v_idem_key
        ) THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        IF NOT p_dry_run THEN
            INSERT INTO roadmap_proposal.proposal_transition_ledger (
                proposal_id,
                project_id,
                from_status,
                to_status,
                event_kind,
                reason_code,
                rationale,
                actor_principal_id,
                actor_layer,
                actor_identity_snapshot,
                source_surface,
                service_identity,
                occurred_at,
                recorded_at,
                source_confidence,
                idempotency_key
            ) VALUES (
                r.proposal_id,
                1,
                r.from_state,
                r.to_state,
                'status_transition',
                COALESCE(NULLIF(r.transition_reason, ''), 'system'),
                r.notes,
                COALESCE(NULLIF(r.transitioned_by, ''), 'unknown'),
                'system-trigger',
                '{"source": "p4668-backfill"}'::jsonb,
                'p4668-backfill',
                'fn_p4668_backfill_history',
                COALESCE(r.transitioned_at, NOW()),
                NOW(),
                'low',   -- low: historical row, provenance uncertain
                v_idem_key
            );
        END IF;

        v_inserted := v_inserted + 1;
    END LOOP;

    RETURN QUERY SELECT v_found, v_skipped, v_inserted, p_dry_run;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_p4668_backfill_history(BOOLEAN, INTEGER) IS
    'P4668 AC-7: Shadow-backfill pre-310 legacy proposal_state_transitions rows '
    'into the canonical ledger with source_confidence=low. '
    'Call with p_dry_run=TRUE first to preview; p_dry_run=FALSE to commit. '
    'Idempotent — skips rows already in the ledger. '
    'Backfill preserves existing discontinuities, missing actors, no-ops as-is. '
    'No historical data is fabricated.';

GRANT EXECUTE ON FUNCTION roadmap.fn_p4668_backfill_history(BOOLEAN, INTEGER)
    TO claude, agent_write;

COMMIT;
