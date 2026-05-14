-- P798: Multi-platform subscription model architecture — Phase 1
--
-- Adds model_metadata.tier + model_route_view for downstream consumers, and
-- extends fn_claim_work_offer so claim-time project route policy is enforced
-- using the claiming agency's preferred_provider. The chosen provider is then
-- stamped onto squad_dispatch.route_provider for later auditability.

BEGIN;

ALTER TABLE roadmap.model_metadata
  ADD COLUMN IF NOT EXISTS tier TEXT
  CHECK (tier IN ('frontier', 'standard', 'economy'));

UPDATE roadmap.model_metadata
SET tier = 'frontier'
WHERE tier IS NULL
  AND model_name LIKE 'claude-%';

UPDATE roadmap.model_metadata
SET tier = 'frontier'
WHERE tier IS NULL
  AND model_name = 'gpt-4o';

UPDATE roadmap.model_metadata
SET tier = 'standard'
WHERE tier IS NULL
  AND model_name = 'gpt-4o-mini';

UPDATE roadmap.model_metadata
SET tier = 'economy'
WHERE tier IS NULL
  AND model_name LIKE 'llama-%';

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
  r.route_provider,
  r.base_url,
  r.is_enabled,
  r.priority
FROM roadmap.model_metadata m
JOIN roadmap.model_routes r
  ON r.model_name = m.model_name;

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS route_provider TEXT;

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
    p_agent_identity text,
    p_required_capabilities jsonb DEFAULT '{}'::jsonb,
    p_lease_ttl_seconds integer DEFAULT 20,
    p_project_id bigint DEFAULT NULL::bigint
)
RETURNS TABLE(
    dispatch_id bigint,
    proposal_id bigint,
    squad_name text,
    dispatch_role text,
    route_provider text,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    offer_version integer,
    metadata jsonb
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_picked_id          bigint;
    v_picked_proposal_id bigint;
    v_route_provider     text;
    v_new_token          uuid        := gen_random_uuid();
    v_expires            timestamptz := now() + make_interval(secs => p_lease_ttl_seconds);
    v_agency_id          bigint;
    v_ceiling_ok         boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM roadmap_workforce.agent_registry
        WHERE agent_identity = p_agent_identity
    ) THEN
        RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT ar.id, ar.preferred_provider
      INTO v_agency_id, v_route_provider
    FROM roadmap_workforce.agent_registry ar
    WHERE ar.agent_identity = p_agent_identity;

    WITH agent_caps AS (
        SELECT ac.capability
        FROM roadmap_workforce.agent_capability ac
        JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
        WHERE ar.agent_identity = p_agent_identity
    ),
    agency_projects AS (
        SELECT pr.project_id
        FROM roadmap_workforce.provider_registry pr
        WHERE pr.agency_id = v_agency_id
          AND pr.is_active = true
        UNION
        SELECT id FROM roadmap_workforce.projects
        WHERE p_project_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM roadmap_workforce.provider_registry pr2
              WHERE pr2.agency_id = v_agency_id AND pr2.is_active = true
          )
    ),
    candidate AS (
        SELECT sd.id, sd.proposal_id
        FROM roadmap_workforce.squad_dispatch sd
        WHERE sd.offer_status = 'open'
          AND (
              (p_project_id IS NOT NULL AND sd.project_id = p_project_id)
              OR (p_project_id IS NULL AND sd.project_id IN (SELECT project_id FROM agency_projects))
          )
          AND (
              sd.required_capabilities = '{}'::jsonb
              OR NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(
                      COALESCE(sd.required_capabilities -> 'all', '[]'::jsonb)
                  ) req(cap)
                  WHERE req.cap NOT IN (SELECT capability FROM agent_caps)
              )
          )
          AND (
              sd.project_id IS NULL
              OR NOT EXISTS (
                  SELECT 1
                  FROM roadmap.project_route_policy pp
                  WHERE pp.project_id = sd.project_id
              )
              OR EXISTS (
                  SELECT 1
                  FROM roadmap.project_route_policy pp
                  WHERE pp.project_id = sd.project_id
                    AND v_route_provider IS NOT NULL
                    AND (
                        array_length(pp.allowed_route_providers, 1) IS NULL
                        OR v_route_provider = ANY(pp.allowed_route_providers)
                    )
                    AND NOT (
                        v_route_provider = ANY(COALESCE(pp.forbidden_route_providers, '{}'))
                    )
              )
          )
        ORDER BY sd.assigned_at ASC
        FOR UPDATE OF sd SKIP LOCKED
        LIMIT 1
    )
    SELECT candidate.id, candidate.proposal_id
      INTO v_picked_id, v_picked_proposal_id
      FROM candidate;

    IF v_picked_id IS NULL THEN
        RETURN;
    END IF;

    IF v_picked_proposal_id IS NOT NULL THEN
        SELECT ok INTO v_ceiling_ok
        FROM roadmap_control.fn_check_concurrency('proposal', v_picked_proposal_id::text);

        IF NOT v_ceiling_ok THEN
            RETURN;
        END IF;
    END IF;

    UPDATE roadmap_workforce.squad_dispatch sd
    SET offer_status = 'claimed',
        agent_identity = p_agent_identity,
        route_provider = COALESCE(v_route_provider, sd.route_provider),
        claim_token = v_new_token,
        claim_expires_at = v_expires,
        claimed_at = now(),
        last_renewed_at = now(),
        offer_version = sd.offer_version + 1
    WHERE sd.id = v_picked_id;

    RETURN QUERY
    SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
           sd.route_provider, sd.claim_token, sd.claim_expires_at,
           sd.offer_version, sd.metadata
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = v_picked_id;
END;
$function$;

COMMIT;
