-- ============================================================================
-- Migration 312 — P4668 AC-25: Break-glass operator escape hatch
-- ----------------------------------------------------------------------------
-- Step 7 of 8 in the P4668 rollout:
--   312: break-glass function and role  ← THIS FILE
--
-- PURPOSE:
--   Installs fn_canonical_transition_break_glass(), the sole permitted escape
--   hatch for operator-emergency status changes. Callable ONLY by the new
--   break_glass_operator DB role — not by roadmap_app, claude, andy, or any
--   agent role.
--
-- AC-25 requirements:
--   1. Security-definer function callable only by break_glass_operator.
--   2. Writes a canonical event with event_kind='break_glass'.
--   3. Mandatory incident_ref (non-empty) and non-empty rationale.
--   4. Cannot skip the immutable ledger insert.
--   5. Privilege test: roadmap_app/claude receives permission denied.
--
-- SAFETY: Purely additive. No existing function, table, or trigger is altered.
-- The new break_glass_operator role has NO other privileges by default.
--
-- ROLLBACK: scripts/migrations/rollback/312-p4668-break-glass.rollback.sql
-- ============================================================================

BEGIN;

-- ── 1. Create break_glass_operator role ──────────────────────────────────────
-- A minimal role with no default privileges. Membership is granted manually
-- by the database superuser only for authorized operator emergency sessions.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'break_glass_operator') THEN
        CREATE ROLE break_glass_operator NOLOGIN;
    END IF;
END;
$$;

COMMENT ON ROLE break_glass_operator IS
    'P4668 AC-25: Sole authorized caller of fn_canonical_transition_break_glass(). '
    'Grant temporarily to operator DB sessions during emergencies. '
    'Do NOT grant to roadmap_app, claude, andy, agent_write, or any automated role. '
    'Revoke immediately after the emergency window closes.';

-- Grant SELECT on the ledger table so the break-glass operator can verify their
-- action and read the chain hash.
GRANT SELECT ON roadmap_proposal.proposal_transition_ledger TO break_glass_operator;
GRANT SELECT ON roadmap_proposal.v_proposal_transition_ledger TO break_glass_operator;

-- ── 2. fn_canonical_transition_break_glass ───────────────────────────────────
-- The sole escape hatch for emergency operator status overrides.
-- Writes event_kind='break_glass' with reason_code='break_glass'.
-- Enforces non-empty incident_ref and rationale — no bypass.

CREATE OR REPLACE FUNCTION roadmap.fn_canonical_transition_break_glass(
    p_proposal_id  BIGINT,
    p_incident_ref TEXT,          -- e.g. 'INC-2026-0042' — non-empty required
    p_rationale    TEXT,          -- human rationale for the override — non-empty required
    p_actor        TEXT,          -- operator identity (DB user or named responder)
    p_to_status    TEXT DEFAULT NULL,    -- target status (optional)
    p_to_maturity  TEXT DEFAULT NULL,    -- target maturity (optional)
    p_from_status  TEXT DEFAULT NULL,    -- prior status (for audit; fetched from proposal if null)
    p_from_maturity TEXT DEFAULT NULL    -- prior maturity (for audit; fetched if null)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, public
AS $$
DECLARE
    v_caller             TEXT;
    v_caller_has_role    BOOLEAN;
    v_event_id           UUID;
    v_from_status        TEXT;
    v_from_maturity      TEXT;
    v_prev_event_hash    TEXT;
    v_event_hash         TEXT;
    v_occurred_at        TIMESTAMPTZ;
    v_idempotency_key    TEXT;
BEGIN
    -- ── Enforce break_glass_operator role ────────────────────────────────────
    -- SECURITY DEFINER runs as the function owner (superuser), so we must
    -- explicitly check the calling role rather than relying on object privileges.
    v_caller := session_user;
    SELECT pg_has_role(v_caller, 'break_glass_operator', 'USAGE')
    INTO v_caller_has_role;

    IF NOT v_caller_has_role THEN
        RAISE EXCEPTION
            'fn_canonical_transition_break_glass: permission denied — '
            'caller % is not a member of break_glass_operator. '
            'Only break_glass_operator members may issue emergency overrides.',
            v_caller;
    END IF;

    -- ── Required field validation ─────────────────────────────────────────────
    IF p_proposal_id IS NULL THEN
        RAISE EXCEPTION 'fn_canonical_transition_break_glass: p_proposal_id is required';
    END IF;
    IF p_incident_ref IS NULL OR trim(p_incident_ref) = '' THEN
        RAISE EXCEPTION
            'fn_canonical_transition_break_glass: p_incident_ref is required and non-empty '
            '(e.g. INC-2026-0042). Attach an incident reference before issuing a break-glass override.';
    END IF;
    IF p_rationale IS NULL OR trim(p_rationale) = '' THEN
        RAISE EXCEPTION
            'fn_canonical_transition_break_glass: p_rationale is required and non-empty. '
            'Document the reason for this emergency override.';
    END IF;
    IF p_actor IS NULL OR trim(p_actor) = '' THEN
        RAISE EXCEPTION 'fn_canonical_transition_break_glass: p_actor is required';
    END IF;

    -- ── Resolve current status/maturity if not supplied ───────────────────────
    IF p_from_status IS NULL OR p_from_maturity IS NULL THEN
        SELECT
            COALESCE(p_from_status,   p.status::text),
            COALESCE(p_from_maturity, p.maturity::text)
        INTO v_from_status, v_from_maturity
        FROM roadmap_proposal.proposal p
        WHERE p.id = p_proposal_id;
    ELSE
        v_from_status   := p_from_status;
        v_from_maturity := p_from_maturity;
    END IF;

    -- ── Hash chain ────────────────────────────────────────────────────────────
    v_occurred_at := NOW();
    v_event_id    := gen_random_uuid();

    SELECT event_hash INTO v_prev_event_hash
    FROM roadmap_proposal.proposal_transition_ledger
    WHERE proposal_id = p_proposal_id
    ORDER BY seq DESC
    LIMIT 1;

    v_event_hash := md5(
        v_event_id::text             || '|' ||
        p_proposal_id::text          || '|' ||
        COALESCE(v_from_status,  '') || '|' ||
        COALESCE(p_to_status,    '') || '|' ||
        COALESCE(v_from_maturity,'') || '|' ||
        COALESCE(p_to_maturity,  '') || '|' ||
        p_actor                      || '|' ||
        'break_glass'                || '|' ||
        v_occurred_at::text          || '|' ||
        COALESCE(v_prev_event_hash, 'GENESIS')
    );

    -- ── Deterministic idempotency key for this break-glass event ─────────────
    -- incident_ref + actor + proposal uniquely identifies one emergency override;
    -- a second call with the same incident in the same session returns the same UUID.
    v_idempotency_key := 'bg:' || p_proposal_id::text || ':' || p_incident_ref;

    -- Return existing event if already committed (idempotent replay)
    DECLARE v_existing UUID;
    BEGIN
        SELECT event_id INTO v_existing
        FROM roadmap_proposal.proposal_transition_ledger
        WHERE idempotency_key = v_idempotency_key
        LIMIT 1;
        IF FOUND THEN
            RETURN v_existing;
        END IF;
    END;

    -- ── Insert canonical break-glass event ───────────────────────────────────
    INSERT INTO roadmap_proposal.proposal_transition_ledger (
        event_id,
        proposal_id,
        project_id,
        from_status,
        to_status,
        from_maturity,
        to_maturity,
        event_kind,
        reason_code,
        rationale,
        actor_principal_id,
        actor_layer,
        actor_identity_snapshot,
        source_surface,
        service_identity,
        additional_state_changes,
        occurred_at,
        recorded_at,
        source_confidence,
        prev_event_hash,
        event_hash,
        idempotency_key
    ) VALUES (
        v_event_id,
        p_proposal_id,
        1,                  -- default project
        v_from_status,
        p_to_status,
        v_from_maturity,
        p_to_maturity,
        'break_glass',
        'break_glass',
        -- Rationale embeds incident ref for single-field searchability
        '[' || p_incident_ref || '] ' || p_rationale,
        p_actor,
        'operator',
        jsonb_build_object(
            'caller_session_user', v_caller,
            'incident_ref',        p_incident_ref,
            'break_glass',         TRUE
        ),
        'break-glass-operator',
        'fn_canonical_transition_break_glass',
        jsonb_build_object('incident_ref', p_incident_ref),
        v_occurred_at,
        NOW(),
        'high',             -- operator-authored event: high confidence
        v_prev_event_hash,
        v_event_hash,
        v_idempotency_key
    );

    RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_canonical_transition_break_glass(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) IS
    'P4668 AC-25: Emergency operator escape hatch. '
    'Callable ONLY by break_glass_operator role members. '
    'Writes an immutable break_glass event with mandatory incident_ref+rationale. '
    'Returns the event UUID. Idempotent per (proposal_id, incident_ref). '
    'roadmap_app, claude, andy, and agent roles receive permission denied. '
    'Always review break_glass events in v_proposal_transition_ledger after use.';

-- ── 3. Privilege policy ───────────────────────────────────────────────────────
-- ONLY break_glass_operator gets EXECUTE. No application or agent role.
-- (The function's internal pg_has_role() check also enforces this, providing
-- defence-in-depth.)
REVOKE EXECUTE ON FUNCTION roadmap.fn_canonical_transition_break_glass(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION roadmap.fn_canonical_transition_break_glass(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
    TO break_glass_operator;

COMMIT;
