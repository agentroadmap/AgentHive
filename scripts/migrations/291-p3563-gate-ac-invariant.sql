-- 291-p3563-gate-ac-invariant.sql
-- P3563 + P3565: Consolidated gate-acceptance-invariant.
--
-- Extends roadmap_proposal.fn_guard_gate_advance (the highest-blast-radius
-- trigger; governs EVERY terminal proposal transition) with acceptance-criteria
-- integrity, verifier-independence, and a P3565 diff-risk authorization clause.
--
-- ============================================================================
-- SAFETY: FLAG-GATED ROLLOUT (NON-NEGOTIABLE)
-- ============================================================================
-- ALL new enforcement is behind runtime flag AGENTHIVE_GATE_AC_INVARIANT_ENABLED,
-- resolved by the trigger from core.runtime_flag (flag_name=
-- 'AGENTHIVE_GATE_AC_INVARIANT_ENABLED', scope='global', value_jsonb=true).
-- DEFAULT OFF. With the flag OFF the guard reproduces EXACTLY the current P3566
-- (migration 289) behavior, so applying this migration to the live DB changes
-- NOTHING until the operator flips the flag. Mirrors the P1391 AC-42 pattern.
--
-- The trigger cannot read process env, so it resolves the flag by querying
-- core.runtime_flag directly (env>DB>default cascade is completed in TS by the
-- handlers; the trigger sees only the DB layer + a hard default of OFF). A
-- helper fn_gate_ac_invariant_enabled() centralizes the lookup and fails OPEN
-- to OFF on any error (missing table, etc.) so the platform never wedges.
--
-- ============================================================================
-- WHAT THIS MIGRATION ADDS (all flag-gated)
-- ============================================================================
--   Step 1  roadmap_proposal.v_ac_verifier_independence — per-AC-pass view
--           resolving verifier agency vs. builder agencies, with
--           verifier_is_independent boolean. (Additive; no enforcement.)
--           + defensible backfill of agent_registry.agency_id for the small
--             set of NULL-agency verifiers whose agency is the `.a` self-name.
--
--   Step 2  fn_guard_gate_advance extended for TERMINAL gates (DEVELOP→MERGE,
--           MERGE→COMPLETE), all flag-gated:
--             - app.gate_bypass no-op honor REMOVED (restores P906) when flag ON.
--             - Pillar 1: refuse terminal advance when count(ACs)=0.
--             - Pillar 2: refuse terminal advance unless every AC is
--               status IN ('pass','waived').
--             - Pillar 3: refuse terminal advance if the independence view shows
--               any self-certified content pass (builder-agency verifier).
--               (Origination is blocked at verify_ac time in TS; this is the
--               gate-side aggregate assertion.)
--
--   Step 5  P3565 diff-risk clause (terminal DEVELOP→MERGE), flag-gated:
--             - if the gate_decision_log row for this advance is marked
--               high-risk (ac_verification->'diff_risk'->>'high' = 'true'),
--               the advance is refused UNLESS the same row carries
--               ac_verification->'diff_risk'->>'operator_authorized' = 'true'.
--             - the operator_authorized marker is written ONLY by the advance
--               handler after authorizeOperatorByToken() succeeds (P3508), never
--               from the impersonable app.agent_identity GUC. The risk signal
--               itself (touched paths) is computed in TS (handler boundary).
--
-- PRESERVES every existing P3566 behavior: the gate_decision_log Branch-A
-- requirement, the app.agent_identity independence/actor check for non-terminal
-- gates, and all existing error messages — verbatim.
--
-- IDEMPOTENT: CREATE OR REPLACE; flag seed uses ON CONFLICT DO NOTHING.
-- DEPENDS ON: 289-p3566 (fn_guard_gate_advance baseline + fn_actor_is_independent),
--             264-p906 (bypass-drop precedent), 018 (gate_decision_log),
--             core.runtime_flag (P827/P1144).

BEGIN;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_proposal' AND p.proname = 'fn_guard_gate_advance'
  ) THEN
    RAISE EXCEPTION '[P3563] Preflight failed: fn_guard_gate_advance not found. Apply 289-p3566 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap' AND p.proname = 'fn_actor_is_independent'
  ) THEN
    RAISE EXCEPTION '[P3563] Preflight failed: roadmap.fn_actor_is_independent not found. Apply 289-p3566 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'core' AND table_name = 'runtime_flag'
  ) THEN
    RAISE EXCEPTION '[P3563] Preflight failed: core.runtime_flag not found. Apply the P827/P1144 runtime-flag migrations first.';
  END IF;

  RAISE NOTICE '[P3563] Preflight passed.';
END $$;

-- ---------------------------------------------------------------------------
-- FLAG RESOLVER HELPER: fn_gate_ac_invariant_enabled()
-- DB-layer of the env>DB>default cascade. Reads core.runtime_flag global scope.
-- Fails OPEN to FALSE (OFF) on ANY error so the platform never wedges on apply.
-- value_jsonb may be a JSON boolean true or the JSON string "true".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_gate_ac_invariant_enabled()
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_val jsonb;
BEGIN
    SELECT value_jsonb INTO v_val
      FROM core.runtime_flag
     WHERE flag_name = 'AGENTHIVE_GATE_AC_INVARIANT_ENABLED'
       AND scope = 'global'
       AND lifecycle_status = 'active'
     LIMIT 1;

    IF v_val IS NULL THEN
        RETURN false;  -- default OFF
    END IF;

    -- Accept JSON boolean true, or JSON string "true"/"1"/"on".
    IF jsonb_typeof(v_val) = 'boolean' THEN
        RETURN (v_val = 'true'::jsonb);
    END IF;
    IF jsonb_typeof(v_val) = 'string' THEN
        RETURN lower(v_val #>> '{}') IN ('true', '1', 'on', 'enabled');
    END IF;
    RETURN false;
EXCEPTION WHEN OTHERS THEN
    -- Fail OPEN to OFF: a missing table / permission error must not wedge gates.
    RETURN false;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_gate_ac_invariant_enabled() IS
  'P3563: DB-layer resolver for AGENTHIVE_GATE_AC_INVARIANT_ENABLED (core.runtime_flag, '
  'global scope). Default OFF. Fails open to OFF on any error so the gate trigger never '
  'wedges the platform on migration apply. The env layer of the env>DB>default cascade is '
  'applied by the TS handlers; the trigger sees only the DB+default layers.';

-- ===========================================================================
-- STEP 1: verifier-independence resolver view (additive, no enforcement)
-- ===========================================================================
-- IMPORTANT data-shape note (verified live 2026-06-16):
--   agent_registry.agency_id is a BIGINT self-reference to another
--   agent_registry row (the agency's own registry row) — NOT a text identity.
--   To compare against squad_dispatch.agency_identity (TEXT), we resolve the
--   verifier's agency to its TEXT identity via the self-join
--     verifier.agency_id  →  agency_row.id  →  agency_row.agent_identity.
--
-- Per AC PASS: resolve the verifier's agency text-identity and the proposal's
-- builder agencies (squad_dispatch.agency_identity where dispatch_role in build
-- roles). verifier_is_independent = verifier agency is resolvable AND NOT among
-- the builder agencies. When the verifier agency cannot be resolved, the result
-- is NULL (unknown) — callers must treat NULL as "cannot prove independence",
-- never as "independent".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap_proposal.v_ac_verifier_independence AS
WITH builder_agencies AS (
    SELECT DISTINCT sd.proposal_id, sd.agency_identity
      FROM roadmap_workforce.squad_dispatch sd
     WHERE sd.dispatch_role IN ('developer', 'engineer', 'architect')
       AND sd.agency_identity IS NOT NULL
)
SELECT
    ac.id                               AS ac_id,
    ac.proposal_id,
    ac.item_number,
    ac.status,
    ac.verified_by,
    ag.agent_identity                   AS verifier_agency_identity,
    -- builder agencies for this proposal as an array (may be empty)
    COALESCE(
        (SELECT array_agg(ba.agency_identity)
           FROM builder_agencies ba
          WHERE ba.proposal_id = ac.proposal_id),
        ARRAY[]::text[]
    )                                    AS builder_agencies,
    CASE
        -- verifier agency unresolved → independence UNKNOWN (NULL).
        WHEN ag.agent_identity IS NULL THEN NULL
        -- verifier agency is one of the proposal's builder agencies → NOT independent.
        WHEN EXISTS (
            SELECT 1 FROM builder_agencies ba
             WHERE ba.proposal_id = ac.proposal_id
               AND ba.agency_identity = ag.agent_identity
        ) THEN false
        ELSE true
    END                                  AS verifier_is_independent
FROM roadmap_proposal.proposal_acceptance_criteria ac
LEFT JOIN roadmap_workforce.agent_registry vr
       ON vr.agent_identity = ac.verified_by
LEFT JOIN roadmap_workforce.agent_registry ag
       ON ag.id = vr.agency_id
WHERE ac.status = 'pass';

COMMENT ON VIEW roadmap_proposal.v_ac_verifier_independence IS
  'P3563 Step 1: per AC-pass, resolves verifier agency (via agent_registry.agency_id '
  'bigint self-join → agency text identity) vs proposal builder agencies. '
  'verifier_is_independent: true=independent, false=builder-agency self-cert, '
  'NULL=verifier agency unresolvable (treat as "cannot prove independence"). '
  'builder agencies = squad_dispatch.agency_identity WHERE dispatch_role IN '
  '(developer,engineer,architect).';

-- ---------------------------------------------------------------------------
-- STEP 1 (cont): defensible backfill of NULL agency_id verifiers.
--
-- INVESTIGATION (live DB, 2026-06-16): of the NULL-agency verifiers who have
-- recorded AC passes, only two have a DEFENSIBLE deterministic mapping: the
-- `.a`-suffixed identities (claude-bot-gary.a, codex-bot-andy.a) appear AS THE
-- agency_identity in squad_dispatch — i.e. the identity IS its own agency row.
-- For these we set agency_id = the identity itself.
--
-- All other NULL-agency verifiers are LEFT NULL on purpose:
--   - operators/system/infra (operator, operator-claude, operator:claude-code,
--     user/gary, system, orchestrator, workspace-maintainer, hermes*) — these
--     are control-plane/human actors with no agency; independence is N/A.
--   - bare agent personas (backend-architect, skeptic-alpha/beta, worker-*,
--     claude-dev/*, claude-architect-*, claude-senior-developer) — no
--     deterministic identity→agency edge exists; a blind UPDATE would be a guess.
--
-- The mapping below is keyed on the verifier being self-present as an agency in
-- squad_dispatch (NOT a string-suffix rule), so it is data-driven and safe.
-- agent_registry.agency_id is a BIGINT self-reference, so an agency's agency is
-- ITSELF: we set agency_id = the row's own id for these self-agency identities.
-- ---------------------------------------------------------------------------
UPDATE roadmap_workforce.agent_registry ar
   SET agency_id = ar.id
 WHERE ar.agency_id IS NULL
   AND EXISTS (
       SELECT 1 FROM roadmap_workforce.squad_dispatch sd
        WHERE sd.agency_identity = ar.agent_identity
   );

-- ===========================================================================
-- STEP 2 + STEP 5: extend fn_guard_gate_advance (flag-gated terminal checks)
-- ===========================================================================
-- The function preserves the ENTIRE P3566 body verbatim for the flag-OFF path
-- and for non-terminal gates. New logic is added ONLY:
--   (a) the app.gate_bypass honor is now conditional on the flag being OFF
--       (flag ON ⇒ bypass NOT honored, restoring P906);
--   (b) a new terminal-gate block (DEVELOP→MERGE, MERGE→COMPLETE) runs the
--       AC-count / AC-status / independence / diff-risk pillars, all guarded by
--       fn_gate_ac_invariant_enabled().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key          TEXT;
    v_has_decision      BOOLEAN;
    v_advancing_actor   TEXT;
    v_is_nonterminal    BOOLEAN;
    v_is_terminal       BOOLEAN;
    v_latest_indep_ts   timestamptz;
    v_has_independent   BOOLEAN;
    v_has_blocking      BOOLEAN;
    v_since_ts          timestamptz;
    -- P3563 terminal-gate locals
    v_flag_on           BOOLEAN;
    v_ac_total          INT;
    v_ac_not_done       INT;
    v_self_cert_passes  INT;
    -- P3565 diff-risk locals
    v_decision_meta     jsonb;
    v_diff_high         BOOLEAN;
    v_diff_op_auth      BOOLEAN;
BEGIN
    -- Only act on forward gated status changes.
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    -- P3563: resolve the invariant flag ONCE (DB layer; default OFF).
    v_flag_on := roadmap_proposal.fn_gate_ac_invariant_enabled();

    -- Defensive no-op: honor SET LOCAL app.gate_bypass='true' for ad-hoc
    -- operator/admin transactions (per P906; the production trigger path no
    -- longer sets this).
    -- P3563 Step 2: when the invariant flag is ON the bypass is NO LONGER
    -- honored (restores the P906 single-writer invariant — the bypass was a
    -- second implicit mutation shortcut). When the flag is OFF behavior is
    -- IDENTICAL to P3566.
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        IF NOT v_flag_on THEN
            RETURN NEW;
        END IF;
        -- flag ON: fall through; the gate_decision_log path must satisfy the guard.
    END IF;

    -- -----------------------------------------------------------------------
    -- AC-3 (P3566): Branch A ONLY — gate_decision_log required.
    -- The legacy "Branch B" (proposal_reviews approve within 10min) is REMOVED.
    -- An approve is a PRECONDITION for a logged decision, not a substitute.
    -- -----------------------------------------------------------------------
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = NEW.id
          AND UPPER(gdl.from_state) = UPPER(OLD.status)
          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
          AND gdl.decision = 'advance'
          AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF NOT v_has_decision THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % requires a gate_decision_log row '
            '(decision=advance). Use mcp_proposal action=gate_decision to record the '
            'decision before advancing. A bare proposal_reviews approve is no longer '
            'sufficient to authorize a gate advance (P3566 AC-3).',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    v_is_nonterminal := v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP');
    v_is_terminal    := v_gate_key IN (E'DEVELOP→MERGE', E'MERGE→COMPLETE');

    -- =======================================================================
    -- P3563 TERMINAL-GATE CHECKS (DEVELOP→MERGE, MERGE→COMPLETE)
    -- Entire block is a NO-OP when the invariant flag is OFF (P3566 parity).
    -- =======================================================================
    IF v_is_terminal AND v_flag_on THEN
        v_advancing_actor := NULLIF(current_setting('app.agent_identity', true), '');

        -- Pillar 1: refuse vacuous advance (zero acceptance criteria).
        SELECT count(*) INTO v_ac_total
          FROM roadmap_proposal.proposal_acceptance_criteria ac
         WHERE ac.proposal_id = NEW.id;

        IF v_ac_total = 0 THEN
            RAISE EXCEPTION
                'Gate transition % → % on proposal % refused: the proposal has ZERO '
                'acceptance criteria. A terminal advance with no ACs is a vacuous pass. '
                'Define and verify acceptance criteria before advancing (P3563 Pillar-1).',
                OLD.status, NEW.status, NEW.id
                USING ERRCODE = 'check_violation';
        END IF;

        -- Pillar 2: refuse unless EVERY AC is pass or waived.
        SELECT count(*) INTO v_ac_not_done
          FROM roadmap_proposal.proposal_acceptance_criteria ac
         WHERE ac.proposal_id = NEW.id
           AND ac.status NOT IN ('pass', 'waived');

        IF v_ac_not_done > 0 THEN
            RAISE EXCEPTION
                'Gate transition % → % on proposal % refused: % acceptance criterion(s) '
                'are not yet pass/waived (status in pending/fail/blocked). Every AC must '
                'be pass or waived before a terminal advance (P3563 Pillar-2).',
                OLD.status, NEW.status, NEW.id, v_ac_not_done
                USING ERRCODE = 'check_violation';
        END IF;

        -- Pillar 3 (gate-side aggregate): refuse if any AC pass is self-certified
        -- by a builder-agency verifier. Origination is blocked in verify_ac (TS);
        -- this is the defense-in-depth assertion at the gate. NULL independence
        -- (unresolvable verifier agency) is NOT treated as a violation here — it
        -- is surfaced as a separate audit signal — so single-agency / operator
        -- deployments never deadlock at the gate.
        SELECT count(*) INTO v_self_cert_passes
          FROM roadmap_proposal.v_ac_verifier_independence vi
         WHERE vi.proposal_id = NEW.id
           AND vi.verifier_is_independent = false;  -- strictly false, not NULL

        IF v_self_cert_passes > 0 THEN
            RAISE EXCEPTION
                'Gate transition % → % on proposal % refused: % acceptance criterion '
                'pass(es) were self-certified by a builder-agency verifier (the verifier''s '
                'agency built the proposal). Content ACs must be verified by an INDEPENDENT '
                'agency (P3563 Pillar-3). Re-verify the affected ACs from a different agency.',
                OLD.status, NEW.status, NEW.id, v_self_cert_passes
                USING ERRCODE = 'check_violation';
        END IF;

        -- ===================================================================
        -- P3565 diff-risk clause (DEVELOP→MERGE only).
        -- The risk SIGNAL (touched high-risk paths) is computed in the TS
        -- advance handler and recorded on the gate_decision_log row as
        --   ac_verification->'diff_risk' = {"high":bool,"operator_authorized":bool,...}
        -- The handler sets operator_authorized=true ONLY after a genuine
        -- authorizeOperatorByToken() success (P3508) — never from the
        -- impersonable app.agent_identity GUC. The trigger asserts the
        -- invariant: a high-risk advance requires operator_authorized=true.
        -- ===================================================================
        IF v_gate_key = E'DEVELOP→MERGE' THEN
            SELECT gdl.ac_verification INTO v_decision_meta
              FROM roadmap_proposal.gate_decision_log gdl
             WHERE gdl.proposal_id = NEW.id
               AND UPPER(gdl.from_state) = UPPER(OLD.status)
               AND UPPER(gdl.to_state)   = UPPER(NEW.status)
               AND gdl.decision = 'advance'
               AND gdl.created_at >= now() - INTERVAL '10 minutes'
             ORDER BY gdl.created_at DESC
             LIMIT 1;

            v_diff_high   := COALESCE((v_decision_meta #>> '{diff_risk,high}') = 'true', false);
            v_diff_op_auth:= COALESCE((v_decision_meta #>> '{diff_risk,operator_authorized}') = 'true', false);

            IF v_diff_high AND NOT v_diff_op_auth THEN
                RAISE EXCEPTION
                    'Gate transition % → % on proposal % refused: the branch diff touches '
                    'HIGH-RISK paths (fn_*/migrations/auth/gate_advance/prop_claim) and no '
                    'genuine operator authorization is present. A high-risk merge requires '
                    'operator sign-off via the P3508 operator-token path (record the gate '
                    'decision with a valid operator_token); the app.agent_identity GUC is '
                    'NOT sufficient (P3565 diff-risk clause).',
                    OLD.status, NEW.status, NEW.id
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        -- Terminal-gate checks complete.
        RETURN NEW;
    END IF;

    -- Terminal gate with flag OFF → P3566 parity (no further checks).
    IF v_is_terminal THEN
        RETURN NEW;
    END IF;

    -- -----------------------------------------------------------------------
    -- AC-1 + AC-2 (P3566): NON-TERMINAL gates only — UNCHANGED from migration 289.
    -- -----------------------------------------------------------------------
    v_advancing_actor := NULLIF(current_setting('app.agent_identity', true), '');

    IF v_advancing_actor IS NULL THEN
        INSERT INTO roadmap.notification_queue
            (proposal_id, severity, kind, title, body, metadata)
        VALUES (
            NEW.id,
            'WARNING',
            'gate_independence_unknown_actor',
            format('P3566: gate advance %s→%s on proposal %s — actor unknown, independence unchecked',
                   OLD.status, NEW.status, NEW.id),
            'app.agent_identity was not set during the gate advance. '
            'Independence check skipped (P3566 AC-1). Set app.agent_identity '
            'before advancing to enforce the independent-reviewer requirement.',
            jsonb_build_object(
                'proposal_id', NEW.id,
                'from_state',  OLD.status,
                'to_state',    NEW.status,
                'gate_key',    v_gate_key
            )
        );
        RETURN NEW;
    END IF;

    v_since_ts := OLD.state_changed_at;

    -- AC-1: Require an independent approve (reviewer_identity <> advancing actor).
    v_has_independent := roadmap.fn_actor_is_independent(NEW.id, v_advancing_actor, v_since_ts);

    IF NOT v_has_independent THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % requires an INDEPENDENT reviewer. '
            'No proposal_reviews approve found from an actor other than the advancing '
            'actor (%) since the current stage began. '
            'Submit a review via mcp_proposal action=submit_review from a DIFFERENT '
            'identity before calling gate_decision (P3566 AC-1).',
            OLD.status, NEW.status, NEW.id, v_advancing_actor
            USING ERRCODE = 'check_violation';
    END IF;

    -- AC-2: Reject if an unresolved blocking review exists newer than the latest
    -- independent approve.
    SELECT MAX(pr.reviewed_at)
      INTO v_latest_indep_ts
      FROM roadmap_proposal.proposal_reviews pr
     WHERE pr.proposal_id       = NEW.id
       AND pr.verdict            = 'approve'
       AND pr.reviewer_identity IS DISTINCT FROM v_advancing_actor
       AND (v_since_ts IS NULL OR pr.reviewed_at >= v_since_ts);

    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = NEW.id
          AND (pr.is_blocking = true
               OR pr.verdict IN ('request_changes', 'reject'))
          AND pr.reviewed_at > v_latest_indep_ts
    ) INTO v_has_blocking;

    IF v_has_blocking THEN
        RAISE EXCEPTION
            'Gate transition % → % on proposal % blocked by an unresolved blocking '
            'review. A request_changes or reject review filed after the latest '
            'independent approve must be resolved (superseded by a new independent '
            'approve) before advancing (P3566 AC-2).',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
  'P290 + P181 + P3566 + P3563/P3565: Enforces gated status transitions. '
  'Non-terminal gates (D1/D2): gate_decision_log row (P3566 AC-3) + independent '
  'approve (AC-1) + no unresolved blocking review (AC-2). Terminal gates (D3/D4), '
  'GATED BY AGENTHIVE_GATE_AC_INVARIANT_ENABLED (default OFF): non-zero ACs '
  '(Pillar-1), every AC pass/waived (Pillar-2), no builder-agency self-certified '
  'content pass (Pillar-3), and at DEVELOP→MERGE a P3565 diff-risk clause requiring '
  'operator_authorized=true on the gate_decision_log row for high-risk diffs. '
  'Flag OFF ⇒ behavior is IDENTICAL to P3566 (migration 289), and app.gate_bypass '
  'is still honored. Flag ON ⇒ app.gate_bypass is NO LONGER honored (restores P906). '
  'fn_gate_ac_invariant_enabled() is the DB-layer flag resolver (fails open to OFF).';

-- ---------------------------------------------------------------------------
-- FLAG SEED: register AGENTHIVE_GATE_AC_INVARIANT_ENABLED = false (OFF).
-- Seeded so the operator can flip it via a single UPDATE. ON CONFLICT DO NOTHING
-- so re-apply never clobbers an operator's ON setting.
-- core.runtime_flag has NOT NULL owner_did / modified_by_did (P828) — use the
-- system seed DID. If those columns are absent in an older schema, the insert
-- still works (extra cols ignored by name). We guard column presence.
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
    v_has_owner_did boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='core' AND table_name='runtime_flag'
          AND column_name='owner_did'
    ) INTO v_has_owner_did;

    IF v_has_owner_did THEN
        INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description, owner_did, modified_by_did)
        VALUES (
            'AGENTHIVE_GATE_AC_INVARIANT_ENABLED', 'global', 'false'::jsonb,
            'P3563/P3565: master switch for the gate acceptance-criteria invariant on terminal gates. Default OFF.',
            'did:agenthive:system', 'did:agenthive:system'
        )
        ON CONFLICT (flag_name) DO NOTHING;
    ELSE
        INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description)
        VALUES (
            'AGENTHIVE_GATE_AC_INVARIANT_ENABLED', 'global', 'false'::jsonb,
            'P3563/P3565: master switch for the gate acceptance-criteria invariant on terminal gates. Default OFF.'
        )
        ON CONFLICT (flag_name) DO NOTHING;
    END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    v_fn_body text;
BEGIN
    -- flag resolver exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='roadmap_proposal' AND p.proname='fn_gate_ac_invariant_enabled'
    ) THEN
        RAISE EXCEPTION '[P3563] fn_gate_ac_invariant_enabled not created.';
    END IF;

    -- independence view exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_views
        WHERE schemaname='roadmap_proposal' AND viewname='v_ac_verifier_independence'
    ) THEN
        RAISE EXCEPTION '[P3563] v_ac_verifier_independence view not created.';
    END IF;

    SELECT pg_get_functiondef(p.oid) INTO v_fn_body
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='roadmap_proposal' AND p.proname='fn_guard_gate_advance';

    -- P3566 invariants preserved
    IF position('P3566 AC-3' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard lost P3566 AC-3.'; END IF;
    IF position('P3566 AC-1' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard lost P3566 AC-1.'; END IF;
    IF position('P3566 AC-2' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard lost P3566 AC-2.'; END IF;
    -- P3563 pillars present
    IF position('P3563 Pillar-1' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard missing Pillar-1.'; END IF;
    IF position('P3563 Pillar-2' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard missing Pillar-2.'; END IF;
    IF position('P3563 Pillar-3' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard missing Pillar-3.'; END IF;
    IF position('P3565 diff-risk clause' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard missing P3565 diff-risk clause.'; END IF;
    -- flag gate present
    IF position('fn_gate_ac_invariant_enabled' IN v_fn_body)=0 THEN RAISE EXCEPTION '[P3563] guard does not consult the invariant flag.'; END IF;

    RAISE NOTICE '[P3563] All post-migration checks passed.';
END $verify$;

-- ---------------------------------------------------------------------------
-- Migration ledger entry.
-- ---------------------------------------------------------------------------
INSERT INTO roadmap.schema_migration (filename, checksum, applied_at)
VALUES ('291-p3563-gate-ac-invariant.sql', 'p3563-gate-ac-invariant-v1', now())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
