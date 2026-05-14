-- Migration 121: P798 Phase 1 — subscription model architecture
--
-- System A: model_metadata.tier column + backfill + model_route_view
-- System B: squad_dispatch.route_provider + policy enforcement in fn_claim_work_offer

BEGIN;

-- ── System A: Model Registry ───────────────────────────────────────────────────

ALTER TABLE model_metadata
  ADD COLUMN IF NOT EXISTS tier TEXT
  CHECK (tier IN ('frontier', 'standard', 'economy'));

-- Frontier: all claude-*, gpt-4o (exact), gpt-4.1 (exact), gpt-5.*, gemini-2.5*, kimi*
UPDATE model_metadata SET tier = 'frontier'
WHERE tier IS NULL AND (
  model_name ILIKE 'claude-%'
  OR model_name = 'gpt-4o'
  OR model_name = 'gpt-4.1'
  OR model_name ILIKE 'gpt-5%'
  OR model_name ILIKE 'gemini-2.5%'
  OR model_name ILIKE '%kimi%'
);

-- Standard: mini variants, codex-mini, gemini-2.0-flash family
UPDATE model_metadata SET tier = 'standard'
WHERE tier IS NULL AND (
  model_name ILIKE 'gpt-4o-mini%'
  OR model_name ILIKE 'gpt-4.1-mini%'
  OR model_name ILIKE 'codex-mini%'
  OR model_name ILIKE 'gemini-2.0-flash%'
);

-- Economy: nano, xiaomi-namespaced models, mimo variants, llama family
UPDATE model_metadata SET tier = 'economy'
WHERE tier IS NULL AND (
  model_name ILIKE 'gpt-4.1-nano%'
  OR model_name ILIKE 'xiaomi/%'
  OR model_name ILIKE 'mimo-%'
  OR model_name ILIKE 'llama-%'
);

-- View joining model_metadata and model_routes for downstream consumers
CREATE OR REPLACE VIEW roadmap.model_route_view AS
SELECT
  m.model_name,
  m.provider,
  m.tier,
  m.cost_per_million_input,
  m.context_window,
  m.capabilities,
  m.rating,
  m.is_active,
  r.id            AS route_id,
  r.route_provider,
  r.base_url,
  r.is_enabled,
  r.priority
FROM model_metadata m
JOIN roadmap.model_routes r
  ON r.model_name = m.model_name;

COMMENT ON VIEW roadmap.model_route_view IS
  'P798: Canonical join of model_metadata (tier, cost, capabilities) and model_routes (provider, priority, is_enabled).';

-- ── System B: Subscription State Machine ──────────────────────────────────────

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS route_provider TEXT;

-- Updated fn_claim_work_offer: project_route_policy enforcement + route_provider capture.
-- Returns new route_provider column alongside existing columns.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
    p_agent_identity     text,
    p_required_capabilities jsonb DEFAULT '{}'::jsonb,
    p_lease_ttl_seconds  integer DEFAULT 20,
    p_project_id         bigint  DEFAULT NULL::bigint
)
RETURNS TABLE(
    dispatch_id      bigint,
    proposal_id      bigint,
    squad_name       text,
    dispatch_role    text,
    claim_token      uuid,
    claim_expires_at timestamp with time zone,
    offer_version    integer,
    metadata         jsonb,
    route_provider   text
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_picked_id           bigint;
    v_picked_proposal_id  bigint;
    v_new_token           uuid        := gen_random_uuid();
    v_expires             timestamptz := now() + make_interval(secs => p_lease_ttl_seconds);
    v_agency_id           bigint;
    v_ceiling_ok          boolean;
    v_route_provider      text;
    v_allowed_providers   text[];
    v_forbidden_providers text[];
    v_dispatch_project    bigint;
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
    -- Qualify with candidate.* to avoid OUT-param collision (SQLSTATE 42702).
    SELECT candidate.id, candidate.proposal_id
      INTO v_picked_id, v_picked_proposal_id
      FROM candidate;

    IF v_picked_id IS NULL THEN
        RETURN;
    END IF;

    -- Check proposal-level concurrency ceiling before claiming.
    IF v_picked_proposal_id IS NOT NULL THEN
        SELECT ok INTO v_ceiling_ok
        FROM   roadmap_control.fn_check_concurrency('proposal', v_picked_proposal_id::text);

        IF NOT v_ceiling_ok THEN
            RETURN;
        END IF;
    END IF;

    -- Resolve project for this dispatch (needed for policy lookup).
    SELECT sd.project_id INTO v_dispatch_project
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.id = v_picked_id;

    -- Load project_route_policy if one exists; treat absent row as unconstrained.
    SELECT rp.allowed_route_providers, rp.forbidden_route_providers
      INTO v_allowed_providers, v_forbidden_providers
    FROM   roadmap.project_route_policy rp
    WHERE  rp.project_id = v_dispatch_project;

    IF NOT FOUND THEN
        v_allowed_providers   := '{}'::text[];
        v_forbidden_providers := '{}'::text[];
    END IF;

    -- Select highest-priority enabled route_provider that satisfies policy.
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

COMMIT;
