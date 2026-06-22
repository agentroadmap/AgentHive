-- ============================================================================
-- Migration 306 — P4668 AC-1/AC-3/AC-13/AC-26: Append-only transition ledger
-- ----------------------------------------------------------------------------
-- Installs the canonical proposal_transition_ledger table and its security-
-- definer insert function. This is Step 1 of 8 in the P4668 rollout:
--   306: ledger DDL + read-only audit tooling  ← THIS FILE
--   307: ledger_event_id FK on proposal_event
--   308: extend proposal_event_type_check
--   309: fix proposal_maturity_transitions CHECKs
--   310: dual-write shim + shadow backfill
--   311: enforce direct-write denial
--   312: break-glass function and role
--   313: switch projections/timeline to canonical ledger
--
-- ORDERING DEPENDENCY: Requires migs 304 (P4625 ledger unification) and 305
-- (P1391 lease-lifecycle views) to be applied on main first.
--
-- SAFETY: Purely additive. No existing table is altered. No existing trigger
-- is changed. Direct-write enforcement is mig 311 — this file only installs
-- the ledger; the old write paths continue to work during the dual-write window.
--
-- ROLLBACK: scripts/migrations/rollback/306-p4668-transition-ledger-ddl.rollback.sql
-- ============================================================================

BEGIN;

-- ── 1. Canonical ledger table ─────────────────────────────────────────────────
-- Append-only: INSERT is the only permitted mutation after creation. No UPDATE
-- or DELETE may be issued by application roles (enforced in mig 311; pre-empted
-- here by not granting UPDATE/DELETE on this table to any application role).
--
-- Actor identity is decomposed into three orthogonal axes per AC-13:
--   Axis 1 — stable principal: actor_principal_id, actor_layer
--   Axis 2 — expert profile:   agent_profile (e.g. 'backend-architect')
--   Axis 3 — resolved route:   resolved_provider, claimed_provider,
--                               provider_mismatch, model_used, route_id, actor_host
-- These are separately-queryable immutable columns, NOT folded into a JSONB blob.

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_transition_ledger (
    -- ── Immutable identity ────────────────────────────────────────────────
    event_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
    seq         BIGINT      GENERATED ALWAYS AS IDENTITY,

    -- ── Proposal context ──────────────────────────────────────────────────
    proposal_id BIGINT      NOT NULL,
    project_id  BIGINT      NOT NULL DEFAULT 1,

    -- ── State change ──────────────────────────────────────────────────────
    from_status   TEXT,
    to_status     TEXT,
    from_maturity TEXT,
    to_maturity   TEXT,

    -- ── Event classification ──────────────────────────────────────────────
    event_kind  TEXT        NOT NULL,
    reason_code TEXT        NOT NULL DEFAULT 'canonical',
    rationale   TEXT,

    -- ── Axis 1 — Stable principal ─────────────────────────────────────────
    actor_principal_id      TEXT    NOT NULL,
    actor_layer             TEXT    NOT NULL,
    actor_identity_snapshot JSONB   NOT NULL DEFAULT '{}',

    -- ── Axis 2 — Expert profile ───────────────────────────────────────────
    agent_profile TEXT,

    -- ── Axis 3 — Resolved execution route ────────────────────────────────
    -- Sourced EXCLUSIVELY from agent_runs / route_decision_log, never from
    -- agent self-report or agency name prefix (AC-14).
    -- actor_host sourced from AGENTHIVE_HOST env or agent_registry snapshot
    -- at write time (AC-31); classified medium confidence when env-sourced.
    resolved_provider TEXT,
    claimed_provider  TEXT,
    provider_mismatch BOOLEAN     NOT NULL DEFAULT FALSE,
    model_used        TEXT,
    route_id          BIGINT,
    actor_host        TEXT,

    -- ── Agency/session context ────────────────────────────────────────────
    agency_identity     TEXT,
    session_id          TEXT,
    delegated_authority JSONB,

    -- ── Governance evidence ───────────────────────────────────────────────
    gate_decision_id         BIGINT,
    review_ids               BIGINT[],
    ac_evidence_snapshot     JSONB,
    ac_evidence_hash         TEXT,
    dependency_snapshot      JSONB,
    dependency_snapshot_hash TEXT,

    -- ── Correlation IDs ───────────────────────────────────────────────────
    lease_id        BIGINT,
    run_id          BIGINT,
    dispatch_id     BIGINT,
    request_id      TEXT,
    correlation_id  TEXT,
    idempotency_key TEXT,

    -- ── Ancillary state mutations (AC-35: gate-pause fields, etc.) ────────
    additional_state_changes JSONB,

    -- ── Source tracing ────────────────────────────────────────────────────
    source_surface   TEXT    NOT NULL DEFAULT 'unknown',
    service_identity TEXT,
    transaction_id   TEXT,

    -- ── Timestamps ────────────────────────────────────────────────────────
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ── Integrity ─────────────────────────────────────────────────────────
    source_confidence TEXT NOT NULL DEFAULT 'high',
    prev_event_hash   TEXT,
    event_hash        TEXT,

    -- ── Constraints ──────────────────────────────────────────────────────
    CONSTRAINT ptl_pkey               PRIMARY KEY (event_id),
    CONSTRAINT ptl_seq_unique         UNIQUE (seq),
    CONSTRAINT ptl_idempotency_unique UNIQUE (idempotency_key),

    CONSTRAINT ptl_fk_proposal FOREIGN KEY (proposal_id)
        REFERENCES roadmap_proposal.proposal(id),

    CONSTRAINT ptl_fk_gate_decision FOREIGN KEY (gate_decision_id)
        REFERENCES roadmap_proposal.gate_decision_log(id),

    -- AC-13: event_kind vocabulary
    CONSTRAINT ptl_event_kind_check CHECK (event_kind = ANY (ARRAY[
        'status_transition',             -- status change (the primary path)
        'maturity_change',               -- explicit maturity write
        'maturity_reset_on_status_change', -- fn_sync_proposal_maturity reset
        'maturity_set',                  -- setMaturity() direct calls
        'break_glass',                   -- operator emergency override
        'compensating_correction',       -- correction to a prior incorrect event
        'federation_sync',               -- cross-tenant sync (AC-36 HIGH-RISK path)
        'gate_pause_demotion'            -- premature-gate demotion (AC-35)
    ])),

    -- AC-13: reason_code vocabulary
    CONSTRAINT ptl_reason_code_check CHECK (reason_code = ANY (ARRAY[
        'canonical',              -- normal write through canonical operation
        'submit',                 -- agent self-submission
        'decision',               -- gate decision advance
        'system',                 -- system/trigger-initiated
        'break_glass',            -- operator emergency (AC-25)
        'compensating_correction', -- correction event
        'federation_sync'         -- cross-tenant sync
    ])),

    -- AC-13: actor_layer vocabulary
    CONSTRAINT ptl_actor_layer_check CHECK (actor_layer = ANY (ARRAY[
        'operator',        -- human operator
        'orchestrator',    -- orchestration loop
        'agency',          -- agency (liaison acting directly)
        'liaison',         -- liaison agent
        'spawn-agent',     -- spawned expert-profile agent
        'system-trigger'   -- DB trigger or system service
    ])),

    -- AC-13: source_confidence vocabulary
    CONSTRAINT ptl_source_confidence_check CHECK (source_confidence = ANY (ARRAY[
        'high',   -- authoritative run/route record available
        'medium', -- env-var or registry-snapshot sourced (AC-31)
        'low'     -- backfill: cannot recover attribution
    ])),

    -- AC-13/AC-5: gated transitions must carry a rationale
    CONSTRAINT ptl_rationale_gated_nonempty CHECK (
        reason_code NOT IN ('decision', 'break_glass')
        OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)
    ),

    -- AC-26: spawn-agent and liaison events require resolved_provider
    CONSTRAINT ptl_spawn_agent_provider_required CHECK (
        actor_layer NOT IN ('spawn-agent', 'liaison')
        OR resolved_provider IS NOT NULL
    )
);

COMMENT ON TABLE roadmap_proposal.proposal_transition_ledger IS
    'P4668 AC-1: Append-only canonical event ledger. '
    'Every proposal status/maturity change must insert exactly one row here atomically. '
    'No UPDATE or DELETE is permitted after insert; corrections use compensating events. '
    'Sole authorized writer: roadmap.fn_canonical_transition_insert() (SECURITY DEFINER). '
    'Direct INSERT from application roles is permitted during the mig-306–310 dual-write '
    'window and revoked in mig 311 (enforcement migration).';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.actor_principal_id IS
    'AC-13 Axis 1: Immutable stable principal (e.g. claude-bot-gary). '
    'The leading provider token in the name is NOMINAL — never trust it as proof of provider. '
    'Survives agent_registry cleanup (registry FK is ON DELETE SET NULL on other tables; '
    'this column is TEXT, not an FK, so it is always preserved).';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.agent_profile IS
    'AC-13 Axis 2: Expert/agency-agent profile (e.g. backend-architect, gate-evaluator). '
    'This is the correct granularity for assessing work quality and independence (P3563/P4663): '
    'same agency, different profile = materially different actor.';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.resolved_provider IS
    'AC-13 Axis 3 / AC-14: Provider that ACTUALLY executed (Claude/Codex/Gemini/…). '
    'Populated EXCLUSIVELY from agent_runs.resolved_provider or route_decision_log. '
    'Never inferred from the agency name prefix. NULL only when actor_layer permits it (AC-26).';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.actor_host IS
    'AC-31: Host where execution occurred. '
    'Sourced from AGENTHIVE_HOST env var or agent_registry snapshot at write time. '
    'source_confidence=medium when env-sourced; high when agent_registry-snapshot sourced.';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.additional_state_changes IS
    'AC-35: Ancillary proposal field mutations that accompany the transition. '
    'For gate_pause_demotion events: records cleared gate_scanner_paused, '
    'gate_paused_by, gate_paused_at values.';

COMMENT ON COLUMN roadmap_proposal.proposal_transition_ledger.event_hash IS
    'MD5 chain hash of canonical fields (event_id, proposal_id, from/to status+maturity, '
    'actor_principal_id, event_kind, occurred_at, prev_event_hash). '
    'Independently verifiable: recompute from stored fields and compare.';

-- ── 2. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ptl_proposal_seq
    ON roadmap_proposal.proposal_transition_ledger (proposal_id, seq ASC);

CREATE INDEX IF NOT EXISTS idx_ptl_actor_principal
    ON roadmap_proposal.proposal_transition_ledger (actor_principal_id);

CREATE INDEX IF NOT EXISTS idx_ptl_gate_decision
    ON roadmap_proposal.proposal_transition_ledger (gate_decision_id)
    WHERE gate_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ptl_event_kind
    ON roadmap_proposal.proposal_transition_ledger (event_kind);

CREATE INDEX IF NOT EXISTS idx_ptl_occurred_at
    ON roadmap_proposal.proposal_transition_ledger (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_ptl_idempotency_key
    ON roadmap_proposal.proposal_transition_ledger (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ── 3. Privilege policy (AC-3) ────────────────────────────────────────────────
-- The new ledger table is INSERT-only from the application perspective.
-- We never grant UPDATE/DELETE/TRUNCATE to any application role.
-- Full enforcement (REVOKE INSERT + force all writes through the security-definer
-- function) is deferred to mig 311 to preserve the dual-write window.
--
-- The REVOKE below is defensive; since this is a new table, no UPDATE/DELETE
-- grants exist yet. It documents intent and guards against accidental future grants.
REVOKE UPDATE, DELETE, TRUNCATE
    ON roadmap_proposal.proposal_transition_ledger
    FROM claude, andy, admin_write;

GRANT SELECT, INSERT
    ON roadmap_proposal.proposal_transition_ledger
    TO claude;

GRANT SELECT
    ON roadmap_proposal.proposal_transition_ledger
    TO agent_read;

GRANT SELECT, INSERT
    ON roadmap_proposal.proposal_transition_ledger
    TO agent_write;

-- ── 4. fn_canonical_transition_insert — security-definer canonical writer ─────
-- The ONLY permitted insert path once enforcement (mig 311) is active.
-- Accepts a JSONB event record, validates required fields, computes the MD5
-- chain hash, handles idempotency, and inserts the immutable event row.
--
-- SECURITY DEFINER: runs as the function owner (admin), which has INSERT.
-- Application roles call this via EXECUTE grant; they never INSERT directly.
--
-- Idempotency: if idempotency_key is provided and already exists in the ledger,
-- returns the existing event_id without inserting a duplicate row (AC-11).
--
-- Called by: src/infra/postgres/canonical-transition.ts

CREATE OR REPLACE FUNCTION roadmap.fn_canonical_transition_insert(
    p_event JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = roadmap_proposal, roadmap, public
AS $$
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
    -- ── Required field extraction ─────────────────────────────────────────
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

    -- ── Required field validation ─────────────────────────────────────────
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

    -- ── AC-5: Gated transitions require non-empty rationale ───────────────
    IF v_reason_code IN ('decision', 'break_glass')
       AND (p_event->>'rationale' IS NULL OR trim(p_event->>'rationale') = '')
    THEN
        RAISE EXCEPTION
            'fn_canonical_transition_insert: rationale is required for reason_code=% transitions',
            v_reason_code;
    END IF;

    -- ── AC-14: Block self-reported provider overwriting resolved route ─────
    -- The resolved_provider field MUST come from authoritative records, not from
    -- the p_event payload's self-reporting. The function enforces this by accepting
    -- resolved_provider from the payload only when it has been pre-validated by
    -- the TypeScript layer from agent_runs / route_decision_log. The distinction
    -- between self-reported and authoritative is enforced at the TypeScript call site
    -- (canonical-transition.ts); the DB function trusts the payload is pre-validated.

    -- ── AC-11: Idempotency guard ──────────────────────────────────────────
    IF v_idempotency_key IS NOT NULL THEN
        SELECT event_id INTO v_event_id
        FROM roadmap_proposal.proposal_transition_ledger
        WHERE idempotency_key = v_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            RETURN v_event_id;
        END IF;
    END IF;

    -- ── Allocate event UUID ───────────────────────────────────────────────
    v_event_id := gen_random_uuid();

    -- ── Previous event hash (chain integrity) ────────────────────────────
    SELECT event_hash INTO v_prev_event_hash
    FROM roadmap_proposal.proposal_transition_ledger
    WHERE proposal_id = v_proposal_id
    ORDER BY seq DESC
    LIMIT 1;

    -- ── Compute event hash (MD5 over canonical fields) ───────────────────
    -- MD5 is used for speed; this is an integrity chain, not a security hash.
    -- The prev_event_hash links form a per-proposal chain that is independently
    -- verifiable by recomputing from stored field values.
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

    -- ── Parse review_ids array ────────────────────────────────────────────
    IF jsonb_typeof(p_event->'review_ids') = 'array' THEN
        SELECT ARRAY(
            SELECT (value::text)::BIGINT
            FROM jsonb_array_elements(p_event->'review_ids')
        ) INTO v_review_ids;
    END IF;

    -- ── Insert the immutable ledger event ─────────────────────────────────
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
        agent_profile,
        resolved_provider,
        claimed_provider,
        provider_mismatch,
        model_used,
        route_id,
        actor_host,
        agency_identity,
        session_id,
        delegated_authority,
        gate_decision_id,
        review_ids,
        ac_evidence_snapshot,
        ac_evidence_hash,
        dependency_snapshot,
        dependency_snapshot_hash,
        lease_id,
        run_id,
        dispatch_id,
        request_id,
        correlation_id,
        idempotency_key,
        additional_state_changes,
        source_surface,
        service_identity,
        transaction_id,
        occurred_at,
        recorded_at,
        source_confidence,
        prev_event_hash,
        event_hash
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
$$;

COMMENT ON FUNCTION roadmap.fn_canonical_transition_insert(JSONB) IS
    'P4668 AC-2/AC-3: Security-definer canonical transition event writer. '
    'The ONLY permitted insert path once mig-311 enforcement is active. '
    'Validates required fields, computes MD5 chain hash, enforces idempotency, '
    'inserts the immutable ledger row, and returns the event UUID. '
    'Called by: src/infra/postgres/canonical-transition.ts. '
    'Do NOT call directly from agent MCP sessions or application code.';

-- Grant EXECUTE to application roles so they can call this function.
-- In mig 311, we also REVOKE INSERT on the table from these roles,
-- making this function the sole permitted write path.
GRANT EXECUTE ON FUNCTION roadmap.fn_canonical_transition_insert(JSONB)
    TO claude, agent_write;

-- ── 5. Read-only audit view ───────────────────────────────────────────────────
-- Ordered per-proposal timeline with missing-evidence flags.
-- Joins to proposal for display_id. Exposes all three actor-identity axes.
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_transition_ledger AS
SELECT
    ptl.seq,
    ptl.event_id,
    ptl.proposal_id,
    p.display_id,
    ptl.project_id,
    ptl.occurred_at,
    ptl.event_kind,
    ptl.reason_code,
    ptl.from_status,
    ptl.to_status,
    ptl.from_maturity,
    ptl.to_maturity,
    -- Axis 1
    ptl.actor_principal_id,
    ptl.actor_layer,
    ptl.actor_identity_snapshot,
    -- Axis 2
    ptl.agent_profile,
    -- Axis 3
    ptl.resolved_provider,
    ptl.claimed_provider,
    ptl.provider_mismatch,
    ptl.model_used,
    ptl.actor_host,
    ptl.route_id,
    -- Evidence references
    ptl.rationale,
    ptl.gate_decision_id,
    ptl.review_ids,
    ptl.lease_id,
    ptl.run_id,
    ptl.source_surface,
    ptl.source_confidence,
    ptl.correlation_id,
    ptl.idempotency_key,
    -- Integrity
    ptl.event_hash,
    ptl.prev_event_hash,
    -- Missing-evidence flags (AC-10)
    (ptl.gate_decision_id IS NULL AND ptl.reason_code = 'decision')
        AS flag_missing_gate_evidence,
    (ptl.actor_layer IN ('spawn-agent','liaison') AND ptl.resolved_provider IS NULL)
        AS flag_missing_provider,
    (ptl.rationale IS NULL AND ptl.reason_code IN ('decision','break_glass'))
        AS flag_missing_rationale,
    (ptl.review_ids IS NULL AND ptl.reason_code = 'decision')
        AS flag_missing_review_ids
FROM roadmap_proposal.proposal_transition_ledger ptl
JOIN roadmap_proposal.proposal p ON p.id = ptl.proposal_id;

COMMENT ON VIEW roadmap_proposal.v_proposal_transition_ledger IS
    'P4668 AC-10: Read-only ordered proposal transition timeline. '
    'Exposes all three actor-identity axes (AC-13) and missing-evidence flags. '
    'Query with WHERE proposal_id = $1 ORDER BY seq ASC for per-proposal timeline.';

-- Grant SELECT on view
GRANT SELECT ON roadmap_proposal.v_proposal_transition_ledger TO claude, agent_read, agent_write;

COMMIT;
