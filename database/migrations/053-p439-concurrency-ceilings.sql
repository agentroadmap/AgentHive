-- P439: State Machine Concurrency Ceilings — hard active-claim limits per scope
--
-- Source of truth: roadmap_control.concurrency_limit (PostgreSQL) +
--                  src/core/control/types.ts (TypeScript ConcurrencyLimitRecord)
--
-- Migration boundary:
--   P435 (migration 051) — creates roadmap_control schema + dispatch/claim tables
--   P443 (migration 052) — feed_event v2 causal fields
--   P439 (this file)     — concurrency_limit table, fn_check_concurrency,
--                          v_concurrency_usage view, and updated fn_claim_work_offer
--
-- Scope hierarchy (enforced in order during claim):
--   global → project → host → agency → proposal → workflow_state → role
--
-- Race safety:
--   fn_check_concurrency materializes a per-scope row (INSERT ON CONFLICT DO NOTHING)
--   and then acquires a per-scope FOR UPDATE lock. The lock is held until the calling
--   transaction commits, so the count-and-claim sequence is atomic. SKIP LOCKED on
--   the dispatch row guarantees no circular wait — deadlock is impossible.
--
-- Required capabilities: control-plane (P435), dispatch/claim tables.

BEGIN;

-- ─── 1. concurrency_limit table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_control.concurrency_limit (
    id                 bigserial PRIMARY KEY,
    scope_type         text NOT NULL
                           CHECK (scope_type IN (
                               'global', 'project', 'host', 'agency',
                               'proposal', 'workflow_state', 'role'
                           )),
    scope_id           text NOT NULL,
    max_active_claims  integer NOT NULL CHECK (max_active_claims  > 0),
    max_active_workers integer NOT NULL CHECK (max_active_workers > 0),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope_type, scope_id)
);

COMMENT ON TABLE roadmap_control.concurrency_limit IS
'Hard active-claim ceilings per scope. scope_id=''__default__'' provides the
per-scope-type default; specific rows (e.g. scope_id=''agency-xyz'') override
that default for the named entity. Rows are materialized on demand by
fn_check_concurrency when a specific entity is first encountered.';

CREATE INDEX IF NOT EXISTS idx_concurrency_limit_scope
    ON roadmap_control.concurrency_limit (scope_type, scope_id);

-- ─── 2. Safe defaults ─────────────────────────────────────────────────────────
--
-- These are conservative starting values; operators can UPDATE individual rows.
-- global=200 / project=50 / host=20 / agency=10 / proposal=2 / state=1 / role=1

INSERT INTO roadmap_control.concurrency_limit
    (scope_type, scope_id, max_active_claims, max_active_workers)
VALUES
    ('global',         '__default__', 200, 200),
    ('project',        '__default__',  50,  50),
    ('host',           '__default__',  20,  20),
    ('agency',         '__default__',  10,  10),
    ('proposal',       '__default__',   2,   2),
    ('workflow_state', '__default__',   1,   1),
    ('role',           '__default__',   1,   1)
ON CONFLICT (scope_type, scope_id) DO NOTHING;

-- ─── 3. fn_check_concurrency ─────────────────────────────────────────────────
--
-- Must be called inside an explicit transaction. The FOR UPDATE on the
-- per-scope row is held until the caller COMMITs or ROLLBACKs, making the
-- count-and-claim sequence atomic with respect to concurrent calls for the
-- same scope_id. Losers queue on the FOR UPDATE; each one sees the updated
-- count after the previous winner commits.

CREATE OR REPLACE FUNCTION roadmap_control.fn_check_concurrency(
    p_scope_type text,
    p_scope_id   text
)
RETURNS TABLE (current_count integer, max_count integer, ok boolean)
LANGUAGE plpgsql AS
$$
DECLARE
    v_max     integer;
    v_current integer := 0;
BEGIN
    -- Materialize the specific scope row if it doesn't exist yet,
    -- inheriting limits from the __default__ row for this scope_type.
    INSERT INTO roadmap_control.concurrency_limit
        (scope_type, scope_id, max_active_claims, max_active_workers)
    SELECT p_scope_type, p_scope_id, c.max_active_claims, c.max_active_workers
    FROM   roadmap_control.concurrency_limit c
    WHERE  c.scope_type = p_scope_type
      AND  c.scope_id   = '__default__'
    ON CONFLICT (scope_type, scope_id) DO NOTHING;

    -- Lock the per-scope row for the duration of the caller's transaction.
    -- Serializes concurrent ceiling checks for the same scope_id.
    SELECT max_active_claims INTO v_max
    FROM   roadmap_control.concurrency_limit
    WHERE  scope_type = p_scope_type
      AND  scope_id   = p_scope_id
    FOR UPDATE;

    IF v_max IS NULL THEN
        -- No default configured for this scope_type — treat as unconstrained.
        RETURN QUERY SELECT 0::integer, 2147483647::integer, true;
        RETURN;
    END IF;

    -- Count committed active claims for this scope (excludes the claim the
    -- caller is about to insert — that hasn't happened yet in this transaction).
    IF p_scope_type = 'global' THEN
        SELECT COUNT(*)::integer INTO v_current
        FROM   roadmap_control.claim
        WHERE  status = 'active';

    ELSIF p_scope_type = 'agency' THEN
        SELECT COUNT(*)::integer INTO v_current
        FROM   roadmap_control.claim  c
        JOIN   roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
        WHERE  c.status    = 'active'
          AND  d.agency_id = p_scope_id;

    ELSIF p_scope_type = 'project' THEN
        SELECT COUNT(*)::integer INTO v_current
        FROM   roadmap_control.claim  c
        JOIN   roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
        WHERE  c.status     = 'active'
          AND  d.project_id = p_scope_id;

    ELSIF p_scope_type = 'host' THEN
        SELECT COUNT(*)::integer INTO v_current
        FROM   roadmap_control.claim  c
        JOIN   roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
        WHERE  c.status = 'active'
          AND  d.host   = p_scope_id;

    ELSIF p_scope_type = 'proposal' THEN
        SELECT COUNT(*)::integer INTO v_current
        FROM   roadmap_control.claim  c
        JOIN   roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
        WHERE  c.status      = 'active'
          AND  d.proposal_id = p_scope_id::integer;

    ELSE
        -- workflow_state / role — not counted at dispatch-claim level yet.
        v_current := 0;
    END IF;

    RETURN QUERY SELECT v_current, v_max, (v_current < v_max);
END;
$$;

COMMENT ON FUNCTION roadmap_control.fn_check_concurrency(text, text) IS
'Check a concurrency ceiling for one scope. Must be called inside an explicit
transaction — the FOR UPDATE is held until COMMIT/ROLLBACK, making the
count-and-claim sequence atomic. Returns (current_count, max_count, ok):
ok=false means the ceiling is reached and the caller must reject the claim.';

-- ─── 4. Update fn_claim_work_offer with concurrency ceiling checks ────────────
--
-- P439 adds three ceiling checks (global → agency → proposal) after locking the
-- chosen squad_dispatch row (SKIP LOCKED).
--
-- IMPORTANT — count source:
--   fn_check_concurrency counts roadmap_control.claim (the TypeScript
--   tryClaimDispatch path). That table is NEVER written by fn_claim_work_offer,
--   so delegating to fn_check_concurrency here would always return current=0.
--   Instead, we count directly from roadmap_workforce.squad_dispatch
--   (offer_status='claimed'), which is exactly what this function writes.
--
-- Lock order (no deadlock possible):
--   squad_dispatch row (SKIP LOCKED, non-blocking)
--   → concurrency_limit row (global __default__, then agency, then proposal)
--   All concurrent callers take locks in the same direction.
--
-- The function signature is UNCHANGED (4 params, 9 return columns including
-- route_provider added by a previous migration).  Only the body is extended.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
    p_agent_identity        text,
    p_required_capabilities jsonb DEFAULT '{}'::jsonb,
    p_lease_ttl_seconds     int   DEFAULT 20,
    p_project_id            int8  DEFAULT NULL
)
RETURNS TABLE (
    dispatch_id      bigint,
    proposal_id      bigint,
    squad_name       text,
    dispatch_role    text,
    claim_token      uuid,
    claim_expires_at timestamptz,
    offer_version    int,
    metadata         jsonb,
    route_provider   text
)
LANGUAGE plpgsql AS
$function$
DECLARE
    v_picked_id           bigint;
    v_picked_proposal_id  bigint;
    v_new_token           uuid        := gen_random_uuid();
    v_expires             timestamptz := now() + make_interval(secs => p_lease_ttl_seconds);
    v_agency_id           bigint;
    v_route_provider      text;
    v_allowed_providers   text[];
    v_forbidden_providers text[];
    v_dispatch_project    bigint;
    -- ceiling check locals (reused across global/agency/proposal checks)
    v_ceil_max            integer;
    v_ceil_current        integer;
BEGIN
    -- Verify caller is a registered agent.
    IF NOT EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry
        WHERE agent_identity = p_agent_identity
    ) THEN
        RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT ar.id INTO v_agency_id
    FROM   roadmap_workforce.agent_registry ar
    WHERE  ar.agent_identity = p_agent_identity;

    -- Pick one open offer with SKIP LOCKED (non-blocking concurrent race).
    WITH agent_caps AS (
        SELECT ac.capability
        FROM   roadmap_workforce.agent_capability ac
        JOIN   roadmap_workforce.agent_registry   ar ON ar.id = ac.agent_id
        WHERE  ar.agent_identity = p_agent_identity
    ),
    agency_projects AS (
        SELECT pr.project_id
        FROM   roadmap_workforce.provider_registry pr
        WHERE  pr.agency_id = v_agency_id
          AND  pr.is_active = true
        UNION
        SELECT id FROM roadmap_workforce.projects
        WHERE  p_project_id IS NULL
          AND  NOT EXISTS (
              SELECT 1 FROM roadmap_workforce.provider_registry pr2
              WHERE pr2.agency_id = v_agency_id AND pr2.is_active = true
          )
    ),
    candidate AS (
        SELECT sd.id, sd.proposal_id
        FROM   roadmap_workforce.squad_dispatch sd
        WHERE  sd.offer_status = 'open'
          AND (
              (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
              OR (p_project_id IS NULL  AND sd.project_id IN (SELECT project_id FROM agency_projects))
          )
          AND (
              sd.required_capabilities = '{}'::jsonb
              OR NOT EXISTS (
                  SELECT 1
                  FROM   jsonb_array_elements_text(
                      COALESCE(sd.required_capabilities -> 'all', '[]'::jsonb)
                  ) req(cap)
                  WHERE  req.cap NOT IN (SELECT capability FROM agent_caps)
              )
          )
        ORDER BY sd.assigned_at ASC
        FOR UPDATE OF sd SKIP LOCKED
        LIMIT 1
    )
    -- Qualify with candidate.* to avoid OUT-param column-name collision (SQLSTATE 42702).
    SELECT candidate.id, candidate.proposal_id
      INTO v_picked_id, v_picked_proposal_id
      FROM candidate;

    IF v_picked_id IS NULL THEN
        RETURN;
    END IF;

    -- ── Concurrency ceiling checks (global → agency → proposal) ──────────────
    --
    -- We count directly from squad_dispatch (offer_status='claimed') because
    -- that is the table this function writes to on success.
    -- fn_check_concurrency counts roadmap_control.claim and is only correct for
    -- the tryClaimDispatch TypeScript path — never call it from this function.
    --
    -- For each scope we:
    --   1. Materialize the per-scope row from the __default__ if absent.
    --   2. Lock that row with FOR UPDATE (held until COMMIT/ROLLBACK), serializing
    --      concurrent ceiling checks for the same scope.
    --   3. Count active claims from squad_dispatch for that scope.
    --   4. Return empty if count >= max.

    -- 1. Global ceiling
    INSERT INTO roadmap_control.concurrency_limit
        (scope_type, scope_id, max_active_claims, max_active_workers)
    SELECT 'global', '__default__', max_active_claims, max_active_workers
    FROM   roadmap_control.concurrency_limit
    WHERE  scope_type = 'global' AND scope_id = '__default__'
    ON CONFLICT (scope_type, scope_id) DO NOTHING;

    SELECT max_active_claims INTO v_ceil_max
    FROM   roadmap_control.concurrency_limit
    WHERE  scope_type = 'global' AND scope_id = '__default__'
    FOR UPDATE;

    IF v_ceil_max IS NOT NULL THEN
        SELECT COUNT(*)::integer INTO v_ceil_current
        FROM   roadmap_workforce.squad_dispatch
        WHERE  offer_status = 'claimed';

        IF v_ceil_current >= v_ceil_max THEN
            RETURN;
        END IF;
    END IF;

    -- 2. Agency ceiling (when caller is a registered agent with an agency row)
    IF v_agency_id IS NOT NULL THEN
        INSERT INTO roadmap_control.concurrency_limit
            (scope_type, scope_id, max_active_claims, max_active_workers)
        SELECT 'agency', p_agent_identity, max_active_claims, max_active_workers
        FROM   roadmap_control.concurrency_limit
        WHERE  scope_type = 'agency' AND scope_id = '__default__'
        ON CONFLICT (scope_type, scope_id) DO NOTHING;

        SELECT max_active_claims INTO v_ceil_max
        FROM   roadmap_control.concurrency_limit
        WHERE  scope_type = 'agency' AND scope_id = p_agent_identity
        FOR UPDATE;

        IF v_ceil_max IS NOT NULL THEN
            SELECT COUNT(*)::integer INTO v_ceil_current
            FROM   roadmap_workforce.squad_dispatch
            WHERE  offer_status   = 'claimed'
              AND  agent_identity = p_agent_identity;

            IF v_ceil_current >= v_ceil_max THEN
                RETURN;
            END IF;
        END IF;
    END IF;

    -- 3. Proposal ceiling (when offer is bound to a proposal)
    IF v_picked_proposal_id IS NOT NULL THEN
        INSERT INTO roadmap_control.concurrency_limit
            (scope_type, scope_id, max_active_claims, max_active_workers)
        SELECT 'proposal', v_picked_proposal_id::text, max_active_claims, max_active_workers
        FROM   roadmap_control.concurrency_limit
        WHERE  scope_type = 'proposal' AND scope_id = '__default__'
        ON CONFLICT (scope_type, scope_id) DO NOTHING;

        SELECT max_active_claims INTO v_ceil_max
        FROM   roadmap_control.concurrency_limit
        WHERE  scope_type = 'proposal' AND scope_id = v_picked_proposal_id::text
        FOR UPDATE;

        IF v_ceil_max IS NOT NULL THEN
            SELECT COUNT(*)::integer INTO v_ceil_current
            FROM   roadmap_workforce.squad_dispatch
            WHERE  offer_status = 'claimed'
              AND  proposal_id  = v_picked_proposal_id;

            IF v_ceil_current >= v_ceil_max THEN
                RETURN;
            END IF;
        END IF;
    END IF;

    -- ── Resolve route_provider via project policy ─────────────────────────────

    SELECT sd.project_id INTO v_dispatch_project
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.id = v_picked_id;

    SELECT rp.allowed_route_providers, rp.forbidden_route_providers
      INTO v_allowed_providers, v_forbidden_providers
    FROM   roadmap.project_route_policy rp
    WHERE  rp.project_id = v_dispatch_project;

    IF NOT FOUND THEN
        v_allowed_providers   := '{}'::text[];
        v_forbidden_providers := '{}'::text[];
    END IF;

    SELECT mr.route_provider INTO v_route_provider
    FROM   roadmap.model_routes mr
    WHERE  mr.is_enabled = true
      AND  (cardinality(v_forbidden_providers) = 0
            OR mr.route_provider <> ALL(v_forbidden_providers))
      AND  (cardinality(v_allowed_providers)   = 0
            OR mr.route_provider = ANY(v_allowed_providers))
    ORDER BY mr.priority DESC, mr.id ASC
    LIMIT 1;

    -- If policy is constraining and no valid route survives, decline the claim.
    IF v_route_provider IS NULL
       AND (cardinality(v_allowed_providers) > 0 OR cardinality(v_forbidden_providers) > 0)
    THEN
        RETURN;
    END IF;

    UPDATE roadmap_workforce.squad_dispatch sd
    SET    offer_status     = 'claimed',
           agent_identity   = p_agent_identity,
           claim_token      = v_new_token,
           claim_expires_at = v_expires,
           claimed_at       = now(),
           last_renewed_at  = now(),
           offer_version    = sd.offer_version + 1,
           route_provider   = v_route_provider
    WHERE  sd.id = v_picked_id;

    RETURN QUERY
    SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
           sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata,
           sd.route_provider
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.id = v_picked_id;
END;
$function$;

-- ─── 5. v_concurrency_usage view ─────────────────────────────────────────────
--
-- Operator-visible snapshot of current active-claim counts vs ceilings.
-- Counts active claims from BOTH claim paths:
--   • roadmap_control.claim  (status='active')   — TypeScript tryClaimDispatch path
--   • roadmap_workforce.squad_dispatch             — SQL fn_claim_work_offer path
--     (offer_status='claimed')
-- The two tables track independent claims (never double-counted).
-- For __default__ rows in non-global scopes, current_active_claims = 0
-- (no dispatch entity has scope_id='__default__').

CREATE OR REPLACE VIEW roadmap_control.v_concurrency_usage AS
SELECT
    cl.scope_type,
    cl.scope_id,
    cl.max_active_claims,
    cl.max_active_workers,
    CASE
        WHEN cl.scope_type = 'global' THEN
            -- control path
            (SELECT COUNT(*)::integer FROM roadmap_control.claim WHERE status = 'active')
            +
            -- workforce path
            (SELECT COUNT(*)::integer FROM roadmap_workforce.squad_dispatch WHERE offer_status = 'claimed')
        WHEN cl.scope_id = '__default__' THEN
            0  -- default rows have no real entity to count against
        WHEN cl.scope_type = 'agency' THEN
            (SELECT COUNT(*)::integer
               FROM roadmap_control.claim  c
               JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
              WHERE c.status    = 'active'
                AND d.agency_id = cl.scope_id)
            +
            (SELECT COUNT(*)::integer
               FROM roadmap_workforce.squad_dispatch
              WHERE offer_status   = 'claimed'
                AND agent_identity = cl.scope_id)
        WHEN cl.scope_type = 'project' THEN
            (SELECT COUNT(*)::integer
               FROM roadmap_control.claim  c
               JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
              WHERE c.status     = 'active'
                AND d.project_id = cl.scope_id)
            +
            (SELECT COUNT(*)::integer
               FROM roadmap_workforce.squad_dispatch
              WHERE offer_status = 'claimed'
                AND project_id::text = cl.scope_id)
        WHEN cl.scope_type = 'host' THEN
            (SELECT COUNT(*)::integer
               FROM roadmap_control.claim  c
               JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
              WHERE c.status = 'active'
                AND d.host   = cl.scope_id)
        WHEN cl.scope_type = 'proposal' THEN
            (SELECT COUNT(*)::integer
               FROM roadmap_control.claim  c
               JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
              WHERE c.status      = 'active'
                AND d.proposal_id = cl.scope_id::integer)
            +
            (SELECT COUNT(*)::integer
               FROM roadmap_workforce.squad_dispatch
              WHERE offer_status = 'claimed'
                AND proposal_id  = cl.scope_id::bigint)
        ELSE 0
    END                                                        AS current_active_claims,
    CASE
        WHEN cl.scope_type = 'global' THEN
            (
                (SELECT COUNT(*)::integer FROM roadmap_control.claim WHERE status = 'active')
                +
                (SELECT COUNT(*)::integer FROM roadmap_workforce.squad_dispatch WHERE offer_status = 'claimed')
            ) >= cl.max_active_claims
        WHEN cl.scope_id = '__default__' THEN
            false
        WHEN cl.scope_type = 'agency' THEN
            (
                (SELECT COUNT(*)::integer
                   FROM roadmap_control.claim c
                   JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
                  WHERE c.status = 'active' AND d.agency_id = cl.scope_id)
                +
                (SELECT COUNT(*)::integer
                   FROM roadmap_workforce.squad_dispatch
                  WHERE offer_status = 'claimed' AND agent_identity = cl.scope_id)
            ) >= cl.max_active_claims
        WHEN cl.scope_type = 'project' THEN
            (
                (SELECT COUNT(*)::integer
                   FROM roadmap_control.claim c
                   JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
                  WHERE c.status = 'active' AND d.project_id = cl.scope_id)
                +
                (SELECT COUNT(*)::integer
                   FROM roadmap_workforce.squad_dispatch
                  WHERE offer_status = 'claimed' AND project_id::text = cl.scope_id)
            ) >= cl.max_active_claims
        WHEN cl.scope_type = 'host' THEN
            (SELECT COUNT(*)::integer
               FROM roadmap_control.claim  c
               JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
              WHERE c.status = 'active' AND d.host = cl.scope_id
            ) >= cl.max_active_claims
        WHEN cl.scope_type = 'proposal' THEN
            (
                (SELECT COUNT(*)::integer
                   FROM roadmap_control.claim c
                   JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
                  WHERE c.status = 'active' AND d.proposal_id = cl.scope_id::integer)
                +
                (SELECT COUNT(*)::integer
                   FROM roadmap_workforce.squad_dispatch
                  WHERE offer_status = 'claimed' AND proposal_id = cl.scope_id::bigint)
            ) >= cl.max_active_claims
        ELSE false
    END                                                        AS at_ceiling
FROM roadmap_control.concurrency_limit cl;

COMMENT ON VIEW roadmap_control.v_concurrency_usage IS
'Operator snapshot: active claim counts vs ceilings per scope.
Aggregates claims from both paths:
  roadmap_control.claim (status=active) — TypeScript tryClaimDispatch path
  roadmap_workforce.squad_dispatch (offer_status=claimed) — SQL fn_claim_work_offer path
Includes __default__ rows (current=0) and per-entity rows from fn_check_concurrency.';

COMMIT;
