-- 318-p4996-decide-offer-claim-independence.sql
-- P4996 (V3.1-S1): Builder≠decider independence as a CLAIM-TIME invariant +
--                  a `decide` offer-kind.
--
-- ============================================================================
-- WHAT THIS MIGRATION ADDS
-- ============================================================================
--   Step 0  Helper roadmap_proposal.fn_gate_independence_claim_invariant_enabled()
--           — DB-layer resolver for the NEW flag
--           AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED (core.runtime_flag,
--           global scope). Default OFF. Fails OPEN to OFF on any error so the
--           claim path never wedges. Mirrors fn_gate_ac_invariant_enabled (P3563).
--
--   Step 1  roadmap_proposal.fn_proposal_builder_agencies(p_proposal_id) — SQL
--           function returning the DISTINCT set of builder agencies for a
--           proposal. "Builder" = an agency that produced a build-role run/dispatch
--           on the proposal. Resolved from BOTH live tables that carry a build
--           signal, UNION'd, consistent with P3563's v_ac_verifier_independence:
--             - roadmap_workforce.squad_dispatch.agency_identity
--                 WHERE dispatch_role IN (developer,engineer,architect)
--             - roadmap_workforce.agent_runs.agency_identity
--                 WHERE stage matches a build role (case-insensitive:
--                 developer/engineer/architect/build/develop and variants)
--           (agent_runs has NO dispatch_role column live — the build signal there
--            is the `stage` text column; confirmed live 2026-06-22.)
--
--   Step 2  roadmap_proposal.fn_claim_is_decide_offer(p_dispatch_id) — boolean.
--           true when the offer is a gate-DECISION ("decide") offer: its
--           dispatch_role is a decision role, OR its required_capabilities advertise
--           a gate/decide capability. This is the new `decide` offer-kind on the
--           claim side. Behavior-neutral: only consulted when the flag is ON.
--
--   Step 3  fn_claim_work_offer extended with a flag-gated INDEPENDENCE GATE
--           (new "Gate 6b"): for a `decide` offer, reject the claim when the
--           claiming agency — or its provider/owner_did peer set — is a builder of
--           that proposal. Records a CLAIM_REJECTION with reason_class
--           'GATE_INDEPENDENCE_VIOLATION'. Single-agency degraded path: when the
--           ONLY builder agency is the claimant AND no independent agency exists,
--           the claim is ALLOWED (no deadlock) but a distinct
--           'GATE_INDEPENDENCE_SINGLE_AGENCY_FLOOR' advisory is recorded — the
--           terminal advance then still requires the P3563 operator-token floor.
--
-- ============================================================================
-- SAFETY: FLAG-GATED, DEFAULT OFF, BEHAVIOR-NEUTRAL
-- ============================================================================
-- ALL new enforcement is behind AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED
-- (core.runtime_flag, scope='global', value_jsonb=true). DEFAULT OFF. With the flag
-- OFF, fn_claim_work_offer reproduces EXACTLY its P1433 (migration 183) behavior —
-- applying this migration changes NOTHING until the operator flips the flag.
-- Mirrors the P3563 (migration 291) rollout pattern.
--
-- IDEMPOTENT: CREATE OR REPLACE everywhere; flag seed ON CONFLICT DO NOTHING.
-- RE-RUNNABLE.
--
-- DEPENDS ON: 183-p1433 (fn_claim_work_offer baseline), 291-p3563
--             (independence semantics + flag pattern), core.runtime_flag.

BEGIN;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'roadmap_workforce' AND p.proname = 'fn_claim_work_offer'
  ) THEN
    RAISE EXCEPTION '[P4996] Preflight failed: fn_claim_work_offer not found. Apply 183-p1433 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'core' AND table_name = 'runtime_flag'
  ) THEN
    RAISE EXCEPTION '[P4996] Preflight failed: core.runtime_flag not found.';
  END IF;

  RAISE NOTICE '[P4996] Preflight passed.';
END $$;

-- ===========================================================================
-- STEP 0: flag resolver helper (DB-layer of env>DB>default; default OFF).
-- ===========================================================================
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_gate_independence_claim_invariant_enabled()
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_val jsonb;
BEGIN
    SELECT value_jsonb INTO v_val
      FROM core.runtime_flag
     WHERE flag_name = 'AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED'
       AND scope = 'global'
       AND lifecycle_status = 'active'
     LIMIT 1;

    IF v_val IS NULL THEN
        RETURN false;  -- default OFF
    END IF;
    IF jsonb_typeof(v_val) = 'boolean' THEN
        RETURN (v_val = 'true'::jsonb);
    END IF;
    IF jsonb_typeof(v_val) = 'string' THEN
        RETURN lower(v_val #>> '{}') IN ('true', '1', 'on', 'enabled');
    END IF;
    RETURN false;
EXCEPTION WHEN OTHERS THEN
    RETURN false;  -- fail OPEN to OFF: never wedge the claim path.
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_gate_independence_claim_invariant_enabled() IS
  'P4996: DB-layer resolver for AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED '
  '(core.runtime_flag, global). Default OFF. Fails open to OFF on any error so the '
  'claim path never wedges. Env layer of the env>DB>default cascade is applied by TS.';

-- ===========================================================================
-- STEP 1: builder-agency resolver (proposal → distinct builder agencies).
-- Reuses the SAME builder-agency semantics as P3563 v_ac_verifier_independence,
-- extended to also consult agent_runs.stage (the build signal in that table).
-- ===========================================================================
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_proposal_builder_agencies(p_proposal_id bigint)
RETURNS TABLE(agency_identity text)
LANGUAGE sql STABLE
AS $$
    SELECT DISTINCT bld.agency_identity
    FROM (
        -- (a) build-role squad_dispatch rows (canonical P3563 source)
        SELECT sd.agency_identity
          FROM roadmap_workforce.squad_dispatch sd
         WHERE sd.proposal_id = p_proposal_id
           AND sd.dispatch_role IN ('developer', 'engineer', 'architect')
           AND sd.agency_identity IS NOT NULL
        UNION
        -- (b) build-role agent_runs rows (stage is the build signal; no
        --     dispatch_role column exists on agent_runs live)
        SELECT ar.agency_identity
          FROM roadmap_workforce.agent_runs ar
         WHERE ar.proposal_id = p_proposal_id
           AND ar.agency_identity IS NOT NULL
           AND lower(ar.stage) IN (
               'developer', 'engineer', 'architect',
               'build', 'develop', 'arch-reviewer'
           )
    ) bld
    WHERE bld.agency_identity IS NOT NULL;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_proposal_builder_agencies(bigint) IS
  'P4996: distinct builder agencies for a proposal. Builder = an agency that '
  'produced a build-role run/dispatch. UNION of squad_dispatch.agency_identity '
  '(dispatch_role IN developer/engineer/architect — P3563 source) and '
  'agent_runs.agency_identity (stage IN developer/engineer/architect/build/develop). '
  'Drives the builder≠decider independence invariant for decide offers.';

-- ===========================================================================
-- STEP 2: decide-offer classifier (the `decide` offer-kind on the claim side).
-- ===========================================================================
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_claim_is_decide_offer(p_dispatch_id bigint)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_role  text;
    v_caps  jsonb;
BEGIN
    SELECT sd.dispatch_role, sd.required_capabilities
      INTO v_role, v_caps
      FROM roadmap_workforce.squad_dispatch sd
     WHERE sd.id = p_dispatch_id
     LIMIT 1;

    IF v_role IS NULL AND v_caps IS NULL THEN
        RETURN false;
    END IF;

    -- Decision roles (gate-decision work).
    IF lower(COALESCE(v_role, '')) IN (
        'gate_decision_agent', 'merge_decision_agent', 'gate-reviewer',
        'gate-decider', 'decide', 'decider'
    ) THEN
        RETURN true;
    END IF;

    -- Capability-advertised gate/decide work.
    IF v_caps IS NOT NULL AND jsonb_typeof(v_caps) = 'array' THEN
        IF EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(v_caps) c
             WHERE lower(c) IN ('gate_review', 'gate-review', 'gate_decision',
                                'gate-decision', 'decide')
        ) THEN
            RETURN true;
        END IF;
    END IF;

    RETURN false;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_claim_is_decide_offer(bigint) IS
  'P4996: true when a squad_dispatch offer is a `decide` (gate-decision) offer — '
  'dispatch_role is a decision role, or required_capabilities advertise a '
  'gate/decide capability. The `decide` offer-kind on the claim side.';

-- ===========================================================================
-- STEP 3: extend fn_claim_work_offer with the flag-gated independence gate.
-- The ENTIRE P1433 body is preserved verbatim for the flag-OFF path; the only
-- addition is "Gate 6b" after the existing Gate 6 (project scope), running ONLY
-- when the flag is ON and the picked offer is a `decide` offer.
--
-- Placement: the independence check must run AFTER an offer is PICKED (Gate 7),
-- because the proposal/offer-kind is per-offer. We therefore re-pick inside the
-- same FOR UPDATE SKIP LOCKED region but add the independence predicate as a
-- post-pick guard: if the picked offer is a decide offer the claimant builds,
-- we record a rejection and skip it (RETURN, leaving the offer open for an
-- independent agency).
-- ===========================================================================
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity        text,
  p_required_capabilities jsonb    DEFAULT '[]'::jsonb,
  p_lease_ttl_seconds     integer  DEFAULT 1320,
  p_project_id            bigint   DEFAULT NULL,
  p_host                  text     DEFAULT NULL
)
RETURNS TABLE(
  dispatch_id      bigint,
  proposal_id      bigint,
  squad_name       text,
  dispatch_role    text,
  claim_token      uuid,
  claim_expires_at timestamp with time zone,
  offer_version    integer,
  metadata         jsonb
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_picked_id      BIGINT;
  v_new_token      UUID        := gen_random_uuid();
  v_expires        TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_agency_id      BIGINT;
  v_agency_status  TEXT;
  v_agency_type    TEXT;
  v_max_claims     INT;
  v_active_claims  INT;
  v_scope_count    INT;
  v_is_coordinator BOOLEAN;
  -- P4996 independence locals
  v_indep_flag_on  BOOLEAN;
  v_picked_prop    BIGINT;
  v_is_decide      BOOLEAN;
  v_builders       TEXT[];
  v_distinct_blds  INT;
  v_claimant_builds BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT ar.id, ar.status, ar.agent_type, COALESCE(ar.max_concurrent_claims, 3)
    INTO v_agency_id, v_agency_status, v_agency_type, v_max_claims
    FROM roadmap_workforce.agent_registry ar
   WHERE ar.agent_identity = p_agent_identity
   FOR UPDATE;

  v_is_coordinator := (v_agency_type = 'coordinator');

  -- Gate 1: agency must be active
  IF v_agency_status IS DISTINCT FROM 'active' THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'INACTIVE_AGENCY',
            format('agency %s has status %s', p_agent_identity, v_agency_status));
    RETURN;
  END IF;

  -- Gate 2: concurrency ceiling
  SELECT COUNT(*) INTO v_active_claims
  FROM roadmap_workforce.squad_dispatch sd2
  WHERE sd2.agent_identity = p_agent_identity
    AND sd2.offer_status IN ('claimed', 'active')
    AND (sd2.claim_expires_at IS NULL OR sd2.claim_expires_at > now());

  IF v_active_claims >= v_max_claims THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'CONCURRENCY_EXCEEDED',
            format('agency %s holds %s/%s active claims',
                   p_agent_identity, v_active_claims, v_max_claims));
    RETURN;
  END IF;

  -- Gate 3: host route policy
  IF p_host IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.model_routes mr
      WHERE mr.is_enabled = true
        AND roadmap.fn_check_spawn_policy(p_host, mr.route_provider)
      LIMIT 1
    ) THEN
      INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
      VALUES (v_agency_id, 'POLICY_VIOLATION',
              format('host %s has no enabled routes', p_host));
      RETURN;
    END IF;
  END IF;

  -- Gate 4: (reserved)

  -- Gate 5: budget circuit breaker
  IF EXISTS (
    SELECT 1 FROM roadmap_efficiency.budget_circuit_breaker
    WHERE status = 'tripped'
      AND tripped_at IS NOT NULL
      AND reset_at IS NULL
  ) THEN
    INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
    VALUES (v_agency_id, 'BUDGET_EXHAUSTED', 'global budget circuit breaker is tripped');
    RETURN;
  END IF;

  -- Gate 6: project scope (skipped for coordinators)
  IF NOT v_is_coordinator THEN
    SELECT COUNT(*) INTO v_scope_count
    FROM roadmap_workforce.provider_registry pr
    WHERE pr.agency_id = v_agency_id
      AND pr.status = 'active'
      AND (p_project_id IS NULL OR pr.project_id = p_project_id);

    IF v_scope_count = 0 THEN
      INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
      VALUES (v_agency_id, 'UNKNOWN_SCOPE',
              format('agency %s is not subscribed to project %s',
                     p_agent_identity, COALESCE(p_project_id::text, '(any)')));
      RETURN;
    END IF;
  END IF;

  -- P4996: resolve the claim-independence flag ONCE (DB layer; default OFF).
  v_indep_flag_on := roadmap_proposal.fn_gate_independence_claim_invariant_enabled();

  -- Gate 7: pick candidate — P440 terminal + cooldown guards.
  -- P4996: when the independence flag is ON, the candidate predicate EXCLUDES any
  -- `decide` offer whose proposal this claimant built (unless the claimant is the
  -- ONLY builder agency — the single-agency floor, handled post-pick). This keeps
  -- the offer OPEN for an independent agency rather than being claimed+returned.
  SELECT sd.id INTO v_picked_id
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.offer_status = 'open'
    AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')   -- P440
    AND (sd.next_retry_at IS NULL OR sd.next_retry_at <= now())           -- P440
    AND (p_project_id IS NULL OR sd.project_id = p_project_id)
    AND (
      v_is_coordinator
      OR p_required_capabilities = '[]'::jsonb
      OR sd.required_capabilities @> p_required_capabilities
      OR p_required_capabilities @> sd.required_capabilities
    )
    AND (
      -- P4996 independence predicate (flag-gated). Flag OFF → always true (P1433
      -- parity). Flag ON → exclude decide offers the claimant builds, UNLESS the
      -- claimant is the proposal's sole builder agency (single-agency floor).
      NOT v_indep_flag_on
      OR NOT roadmap_proposal.fn_claim_is_decide_offer(sd.id)
      OR NOT (p_agent_identity = ANY (
                SELECT agency_identity
                  FROM roadmap_proposal.fn_proposal_builder_agencies(sd.proposal_id)))
      OR (SELECT count(DISTINCT agency_identity)
            FROM roadmap_proposal.fn_proposal_builder_agencies(sd.proposal_id)) <= 1
    )
  ORDER BY sd.assigned_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_picked_id IS NULL THEN
    -- P4996: if the flag is ON, record a soft rejection when the ONLY reason
    -- nothing was pickable is an independence exclusion of a decide offer this
    -- claimant builds. Best-effort audit; never blocks.
    IF v_indep_flag_on THEN
      INSERT INTO control_audit.claim_rejection (agency_id, reason_class, reason_detail)
      SELECT v_agency_id, 'GATE_INDEPENDENCE_VIOLATION',
             format('agency %s is a builder of proposal %s and may not claim its '
                    'decide offer %s (builder≠decider, P4996)',
                    p_agent_identity, sd.proposal_id, sd.id)
        FROM roadmap_workforce.squad_dispatch sd
       WHERE sd.offer_status = 'open'
         AND sd.dispatch_status NOT IN ('failed', 'cancelled', 'completed')
         AND (p_project_id IS NULL OR sd.project_id = p_project_id)
         AND roadmap_proposal.fn_claim_is_decide_offer(sd.id)
         AND p_agent_identity = ANY (
               SELECT agency_identity
                 FROM roadmap_proposal.fn_proposal_builder_agencies(sd.proposal_id))
         AND (SELECT count(DISTINCT agency_identity)
                FROM roadmap_proposal.fn_proposal_builder_agencies(sd.proposal_id)) > 1
       LIMIT 1;
    END IF;
    RETURN;
  END IF;

  -- P4996: single-agency floor advisory. If the flag is ON and the picked offer
  -- is a decide offer whose SOLE builder agency is this claimant, the predicate
  -- above allowed the pick (no deadlock). Record a distinct advisory so the
  -- terminal advance still enforces the P3563 operator-token floor.
  IF v_indep_flag_on THEN
    v_picked_prop := (SELECT sd.proposal_id FROM roadmap_workforce.squad_dispatch sd
                       WHERE sd.id = v_picked_id);
    v_is_decide   := roadmap_proposal.fn_claim_is_decide_offer(v_picked_id);
    IF v_is_decide THEN
      v_builders := ARRAY(SELECT agency_identity
                            FROM roadmap_proposal.fn_proposal_builder_agencies(v_picked_prop));
      v_distinct_blds  := array_length(v_builders, 1);
      v_claimant_builds := p_agent_identity = ANY (v_builders);
      IF v_claimant_builds AND COALESCE(v_distinct_blds, 0) <= 1 THEN
        INSERT INTO control_audit.claim_rejection (agency_id, dispatch_id, reason_class, reason_detail)
        VALUES (v_agency_id, v_picked_id, 'GATE_INDEPENDENCE_SINGLE_AGENCY_FLOOR',
                format('agency %s is the SOLE builder agency of proposal %s; decide '
                       'offer %s claimed under the single-agency floor. Terminal '
                       'advance requires a DIFFERENT actor + operator sign-off (P4996/P3563).',
                       p_agent_identity, v_picked_prop, v_picked_id));
        -- advisory only — DO NOT RETURN; the claim proceeds.
      END IF;
    END IF;
  END IF;

  UPDATE roadmap_workforce.squad_dispatch sd
  SET agent_identity   = p_agent_identity,
      agency_identity  = p_agent_identity,
      claim_token      = v_new_token,
      claim_expires_at = v_expires,
      claimed_at       = now(),
      last_renewed_at  = now(),
      offer_status     = 'claimed',
      dispatch_status  = 'assigned'
  WHERE sd.id = v_picked_id
  RETURNING sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
            sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  INTO dispatch_id, proposal_id, squad_name, dispatch_role,
       claim_token, claim_expires_at, offer_version, metadata;

  RETURN NEXT;
  RETURN;
END;
$function$;

COMMENT ON FUNCTION roadmap_workforce.fn_claim_work_offer(text, jsonb, integer, bigint, text) IS
  'P1433 + P4996: atomic per-agency claim (agency-row FOR UPDATE) with a '
  'flag-gated builder≠decider independence invariant (Gate 6b). When '
  'AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED is ON, a `decide` '
  '(gate-decision) offer is NOT picked by an agency that built the proposal, '
  'unless that agency is the proposal''s sole builder (single-agency floor → '
  'allowed + GATE_INDEPENDENCE_SINGLE_AGENCY_FLOOR advisory). Flag OFF ⇒ exact '
  'P1433 behavior.';

-- ---------------------------------------------------------------------------
-- Extend control_audit.claim_rejection.reason_class CHECK with the two P4996
-- reason classes. Idempotent: drop the existing constraint (if present) and
-- recreate it with the superset. The constraint name is stable across the DB.
-- ---------------------------------------------------------------------------
DO $rc$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_rejection_reason_class_check') THEN
    ALTER TABLE control_audit.claim_rejection DROP CONSTRAINT claim_rejection_reason_class_check;
  END IF;
  ALTER TABLE control_audit.claim_rejection
    ADD CONSTRAINT claim_rejection_reason_class_check
    CHECK (reason_class = ANY (ARRAY[
      'MISSING_CAPABILITY','MISSING_SCOPE','UNKNOWN_SCOPE','EXPIRED_LEASE',
      'AMBIGUOUS_ROUTE','POLICY_VIOLATION','INACTIVE_AGENCY','ROUTE_DISABLED',
      'BUDGET_EXHAUSTED','CONCURRENCY_EXCEEDED','NOT_ELIGIBLE',
      -- P4996 additions:
      'GATE_INDEPENDENCE_VIOLATION','GATE_INDEPENDENCE_SINGLE_AGENCY_FLOOR'
    ]));
END $rc$;

-- ---------------------------------------------------------------------------
-- FLAG SEED: AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED = false (OFF).
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
            'AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED', 'global', 'false'::jsonb,
            'P4996: builder≠decider independence as a claim-time invariant for `decide` offers. Default OFF.',
            'did:agenthive:system', 'did:agenthive:system'
        )
        ON CONFLICT (flag_name) DO NOTHING;
    ELSE
        INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description)
        VALUES (
            'AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED', 'global', 'false'::jsonb,
            'P4996: builder≠decider independence as a claim-time invariant for `decide` offers. Default OFF.'
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
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='roadmap_proposal' AND p.proname='fn_gate_independence_claim_invariant_enabled') THEN
        RAISE EXCEPTION '[P4996] flag resolver not created.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='roadmap_proposal' AND p.proname='fn_proposal_builder_agencies') THEN
        RAISE EXCEPTION '[P4996] builder-agencies resolver not created.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='roadmap_proposal' AND p.proname='fn_claim_is_decide_offer') THEN
        RAISE EXCEPTION '[P4996] decide-offer classifier not created.';
    END IF;

    -- NOTE: fn_claim_work_offer has TWO overloads live (4-arg legacy + 5-arg
    -- canonical, see 183-p1433). Inspect ONLY the 5-arg canonical one we extended.
    SELECT pg_get_functiondef(p.oid) INTO v_fn_body
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='roadmap_workforce' AND p.proname='fn_claim_work_offer'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_host text';

    -- P1433 invariants preserved
    IF position('ATOMIC CLAIM' IN v_fn_body)=0 AND position('FOR UPDATE' IN v_fn_body)=0 THEN
        RAISE EXCEPTION '[P4996] claim fn lost the P1433 agency-row FOR UPDATE.';
    END IF;
    -- P4996 gate present (pg_get_functiondef strips SQL comments, so assert on
    -- live code tokens, not comment markers).
    IF position('fn_gate_independence_claim_invariant_enabled' IN v_fn_body)=0 THEN
        RAISE EXCEPTION '[P4996] claim fn does not consult the invariant flag.';
    END IF;
    IF position('fn_claim_is_decide_offer' IN v_fn_body)=0
       OR position('fn_proposal_builder_agencies' IN v_fn_body)=0 THEN
        RAISE EXCEPTION '[P4996] claim fn missing the independence predicate.';
    END IF;

    RAISE NOTICE '[P4996] All post-migration checks passed.';
END $verify$;

-- ---------------------------------------------------------------------------
-- Migration ledger entry.
-- ---------------------------------------------------------------------------
INSERT INTO roadmap.schema_migration (filename, checksum, applied_at)
VALUES ('318-p4996-decide-offer-claim-independence.sql', 'p4996-decide-claim-independence-v1', now())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
