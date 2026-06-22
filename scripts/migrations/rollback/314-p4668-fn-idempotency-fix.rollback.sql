-- ============================================================================
-- Rollback for Migration 314 — P4668 fn_canonical_transition_insert idempotency fix
-- ----------------------------------------------------------------------------
-- Restores the mig 306 version of fn_canonical_transition_insert without the
-- EXCEPTION WHEN unique_violation handler. After rollback, concurrent calls
-- with the same idempotency_key may raise unique_violation under contention.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_canonical_transition_insert(p_event jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'roadmap_proposal', 'roadmap', 'public'
AS $function$
DECLARE
    v_event_id         UUID;
    v_proposal_id      BIGINT;
    v_actor_principal  TEXT;
    v_actor_layer      TEXT;
    v_event_kind       TEXT;
    v_reason_code      TEXT;
    v_occurred_at      TIMESTAMPTZ;
    v_event_hash       TEXT;
    v_prev_event_hash  TEXT;
    v_idempotency_key  TEXT;
    v_review_ids       BIGINT[];
BEGIN
    v_proposal_id     := (p_event->>'proposal_id')::BIGINT;
    v_actor_principal := p_event->>'actor_principal_id';
    v_actor_layer     := p_event->>'actor_layer';
    v_event_kind      := p_event->>'event_kind';
    v_reason_code     := COALESCE(NULLIF(p_event->>'reason_code', ''), 'canonical');
    v_occurred_at     := COALESCE(
        NULLIF(p_event->>'occurred_at', '')::TIMESTAMPTZ,
        NOW()
    );
    v_idempotency_key := NULLIF(p_event->>'idempotency_key', '');

    IF v_proposal_id IS NULL THEN
        RAISE EXCEPTION 'fn_canonical_transition_insert: proposal_id is required';
    END IF;
    IF v_actor_principal IS NULL OR trim(v_actor_principal) = '' THEN
        RAISE EXCEPTION 'fn_canonical_transition_insert: actor_principal_id is required';
    END IF;
    IF v_actor_layer IS NULL THEN
        RAISE EXCEPTION 'fn_canonical_transition_insert: actor_layer is required';
    END IF;
    IF v_event_kind IS NULL THEN
        RAISE EXCEPTION 'fn_canonical_transition_insert: event_kind is required';
    END IF;

    IF v_reason_code IN ('decision', 'break_glass')
       AND (p_event->>'rationale' IS NULL OR trim(p_event->>'rationale') = '')
    THEN
        RAISE EXCEPTION
            'fn_canonical_transition_insert: rationale is required for reason_code=% transitions',
            v_reason_code;
    END IF;

    IF v_idempotency_key IS NOT NULL THEN
        SELECT event_id INTO v_event_id
        FROM roadmap_proposal.proposal_transition_ledger
        WHERE idempotency_key = v_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            RETURN v_event_id;
        END IF;
    END IF;

    v_event_id := gen_random_uuid();

    SELECT event_hash INTO v_prev_event_hash
    FROM roadmap_proposal.proposal_transition_ledger
    WHERE proposal_id = v_proposal_id
    ORDER BY seq DESC
    LIMIT 1;

    v_event_hash := md5(
        v_event_id::text                               || '|' ||
        v_proposal_id::text                            || '|' ||
        COALESCE(p_event->>'from_status',   '')        || '|' ||
        COALESCE(p_event->>'to_status',     '')        || '|' ||
        COALESCE(p_event->>'from_maturity', '')        || '|' ||
        COALESCE(p_event->>'to_maturity',   '')        || '|' ||
        v_actor_principal                              || '|' ||
        v_event_kind                                   || '|' ||
        v_occurred_at::text                            || '|' ||
        COALESCE(v_prev_event_hash, 'GENESIS')
    );

    IF jsonb_typeof(p_event->'review_ids') = 'array' THEN
        SELECT ARRAY(
            SELECT (value::text)::BIGINT
            FROM jsonb_array_elements(p_event->'review_ids')
        ) INTO v_review_ids;
    END IF;

    INSERT INTO roadmap_proposal.proposal_transition_ledger (
        event_id, proposal_id, project_id, from_status, to_status,
        from_maturity, to_maturity, event_kind, reason_code, rationale,
        actor_principal_id, actor_layer, actor_identity_snapshot, agent_profile,
        resolved_provider, claimed_provider, provider_mismatch, model_used,
        route_id, actor_host, agency_identity, session_id, delegated_authority,
        gate_decision_id, review_ids, ac_evidence_snapshot, ac_evidence_hash,
        dependency_snapshot, dependency_snapshot_hash, lease_id, run_id,
        dispatch_id, request_id, correlation_id, idempotency_key,
        additional_state_changes, source_surface, service_identity,
        transaction_id, occurred_at, recorded_at, source_confidence,
        prev_event_hash, event_hash
    ) VALUES (
        v_event_id,
        v_proposal_id,
        COALESCE(NULLIF(p_event->>'project_id', '')::BIGINT, 1),
        NULLIF(p_event->>'from_status',   ''),
        NULLIF(p_event->>'to_status',     ''),
        NULLIF(p_event->>'from_maturity', ''),
        NULLIF(p_event->>'to_maturity',   ''),
        v_event_kind,
        v_reason_code,
        NULLIF(p_event->>'rationale', ''),
        v_actor_principal,
        v_actor_layer,
        COALESCE(p_event->'actor_identity_snapshot', '{}'),
        NULLIF(p_event->>'agent_profile', ''),
        NULLIF(p_event->>'resolved_provider', ''),
        NULLIF(p_event->>'claimed_provider',  ''),
        COALESCE(NULLIF(p_event->>'provider_mismatch', '')::BOOLEAN, FALSE),
        NULLIF(p_event->>'model_used',    ''),
        NULLIF(p_event->>'route_id',      '')::BIGINT,
        NULLIF(p_event->>'actor_host',    ''),
        NULLIF(p_event->>'agency_identity', ''),
        NULLIF(p_event->>'session_id',      ''),
        p_event->'delegated_authority',
        NULLIF(p_event->>'gate_decision_id', '')::BIGINT,
        v_review_ids,
        p_event->'ac_evidence_snapshot',
        NULLIF(p_event->>'ac_evidence_hash', ''),
        p_event->'dependency_snapshot',
        NULLIF(p_event->>'dependency_snapshot_hash', ''),
        NULLIF(p_event->>'lease_id',     '')::BIGINT,
        NULLIF(p_event->>'run_id',       '')::BIGINT,
        NULLIF(p_event->>'dispatch_id',  '')::BIGINT,
        NULLIF(p_event->>'request_id',   ''),
        NULLIF(p_event->>'correlation_id', ''),
        v_idempotency_key,
        p_event->'additional_state_changes',
        COALESCE(NULLIF(p_event->>'source_surface', ''), 'unknown'),
        NULLIF(p_event->>'service_identity', ''),
        NULLIF(p_event->>'transaction_id',   ''),
        v_occurred_at,
        NOW(),
        COALESCE(NULLIF(p_event->>'source_confidence', ''), 'high'),
        v_prev_event_hash,
        v_event_hash
    );

    RETURN v_event_id;
END;
$function$;

COMMIT;
