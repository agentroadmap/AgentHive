-- P798: Multi-platform subscription model architecture — Phase 1
--
-- System A: Model Registry
--   - Add tier column to roadmap.model_metadata (frontier/standard/economy)
--   - Backfill tier for known models
--   - Create roadmap.model_route_view joining model_metadata + model_routes
--
-- System B: Subscription State Machine — route_provider capture
--   - Add route_provider column to roadmap_workforce.squad_dispatch
--   - Update fn_claim_work_offer to:
--     (a) resolve route_provider from model_routes at claim time
--     (b) check project_route_policy (P767) allow/forbid before granting lease
--     (c) return route_provider in result set

BEGIN;

-- ── System A: tier column ─────────────────────────────────────────────────────

ALTER TABLE roadmap.model_metadata
  ADD COLUMN IF NOT EXISTS tier TEXT
  CHECK (tier IN ('frontier', 'standard', 'economy'));

COMMENT ON COLUMN roadmap.model_metadata.tier IS
  'Capability tier: frontier (latest frontier), standard (balanced), economy (low-cost). '
  'Used by model_route_view and downstream route resolvers.';

-- Backfill tier for known provider families
UPDATE roadmap.model_metadata SET tier = 'frontier'
  WHERE (model_name LIKE 'claude-%' OR model_name LIKE 'anthropic/%')
    AND tier IS NULL;

UPDATE roadmap.model_metadata SET tier = 'frontier'
  WHERE model_name IN ('gpt-4o', 'gpt-4-turbo', 'gpt-4')
    AND tier IS NULL;

UPDATE roadmap.model_metadata SET tier = 'standard'
  WHERE model_name IN ('gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-3.5-turbo-instruct')
    AND tier IS NULL;

UPDATE roadmap.model_metadata SET tier = 'economy'
  WHERE (model_name LIKE 'llama-%' OR model_name LIKE 'meta-llama/%'
         OR model_name LIKE 'xiaomi/%' OR model_name LIKE 'mistral-%'
         OR model_name LIKE 'nous/%')
    AND tier IS NULL;

-- ── System A: model_route_view ────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.model_route_view AS
  SELECT
    m.model_name,
    m.provider,
    m.tier,
    m.cost_per_million_input,
    m.cost_per_million_output,
    m.context_window,
    m.capabilities,
    m.rating,
    m.is_active,
    r.route_provider,
    r.base_url,
    r.is_enabled,
    r.priority
  FROM roadmap.model_metadata  m
  JOIN roadmap.model_routes    r ON r.model_name = m.model_name;

COMMENT ON VIEW roadmap.model_route_view IS
  'Canonical join of model capabilities (model_metadata) with routing config (model_routes). '
  'Filter by is_enabled=true for dispatch; include disabled routes for ops visibility.';

GRANT SELECT ON roadmap.model_route_view TO roadmap_agent;

-- ── System B: route_provider column on squad_dispatch ─────────────────────────

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS route_provider TEXT;

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.route_provider IS
  'Route provider resolved at claim time via model_routes. '
  'Enables Route Capability Resolver (System C, Phase 2) to audit actual vs intended routing.';

-- ── System B: updated fn_claim_work_offer ─────────────────────────────────────
--
-- Changes vs migration 115:
--   1. Resolve v_route_provider from model_routes using metadata->>'model' at claim time.
--   2. Enforce project_route_policy (P767): forbidden check first, then allowlist.
--      Empty allowed_route_providers = allow any.
--   3. Stamp squad_dispatch.route_provider on UPDATE.
--   4. Return route_provider in RETURNS TABLE.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
    p_agent_identity text,
    p_required_capabilities jsonb DEFAULT '{}'::jsonb,
    p_lease_ttl_seconds integer DEFAULT 20,
    p_project_id bigint DEFAULT NULL::bigint
)
RETURNS TABLE(
    dispatch_id        bigint,
    proposal_id        bigint,
    squad_name         text,
    dispatch_role      text,
    claim_token        uuid,
    claim_expires_at   timestamp with time zone,
    offer_version      integer,
    metadata           jsonb,
    route_provider     text
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_picked_id          bigint;
    v_picked_proposal_id bigint;
    v_picked_project_id  bigint;
    v_picked_model       text;
    v_new_token          uuid        := gen_random_uuid();
    v_expires            timestamptz := now() + make_interval(secs => p_lease_ttl_seconds);
    v_agency_id          bigint;
    v_ceiling_ok         boolean;
    v_route_provider     text;
    v_policy_ok          boolean     := true;
    v_allowed            text[];
    v_forbidden          text[];
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
        SELECT sd.id, sd.proposal_id, sd.project_id, sd.metadata->>'model' AS model_hint
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
    SELECT candidate.id, candidate.proposal_id, candidate.project_id, candidate.model_hint
      INTO v_picked_id, v_picked_proposal_id, v_picked_project_id, v_picked_model
      FROM candidate;

    IF v_picked_id IS NULL THEN
        RETURN;
    END IF;

    -- Proposal-level concurrency ceiling.
    IF v_picked_proposal_id IS NOT NULL THEN
        SELECT ok INTO v_ceiling_ok
        FROM   roadmap_control.fn_check_concurrency('proposal', v_picked_proposal_id::text);

        IF NOT v_ceiling_ok THEN
            RETURN;
        END IF;
    END IF;

    -- Resolve route_provider from model_routes (best enabled route for this model).
    IF v_picked_model IS NOT NULL THEN
        SELECT r.route_provider INTO v_route_provider
        FROM   roadmap.model_routes r
        WHERE  r.model_name = v_picked_model
          AND  r.is_enabled  = true
        ORDER BY r.priority ASC
        LIMIT 1;
    END IF;

    -- Enforce project_route_policy (P767) when a route provider is known.
    IF v_route_provider IS NOT NULL AND v_picked_project_id IS NOT NULL THEN
        SELECT prp.allowed_route_providers,
               prp.forbidden_route_providers
          INTO v_allowed, v_forbidden
          FROM roadmap.project_route_policy prp
         WHERE prp.project_id = v_picked_project_id;

        IF FOUND THEN
            -- Forbidden list always wins regardless of allowed list.
            IF v_route_provider = ANY(v_forbidden) THEN
                v_policy_ok := false;
            -- Non-empty allowed list acts as an explicit allowlist.
            ELSIF cardinality(v_allowed) > 0
              AND NOT (v_route_provider = ANY(v_allowed)) THEN
                v_policy_ok := false;
            END IF;
        END IF;
        -- Missing policy row → open policy (allow any provider).

        IF NOT v_policy_ok THEN
            RETURN;
        END IF;
    END IF;

    -- Claim the offer and stamp route_provider.
    UPDATE roadmap_workforce.squad_dispatch sd
    SET    offer_status    = 'claimed',
           agent_identity  = p_agent_identity,
           claim_token     = v_new_token,
           claim_expires_at = v_expires,
           claimed_at      = now(),
           last_renewed_at = now(),
           offer_version   = sd.offer_version + 1,
           route_provider  = v_route_provider
    WHERE  sd.id = v_picked_id;

    RETURN QUERY
    SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
           sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata,
           sd.route_provider
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.id = v_picked_id;
END;
$function$;

COMMIT;
