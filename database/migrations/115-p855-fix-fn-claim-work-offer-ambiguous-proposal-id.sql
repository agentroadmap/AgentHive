-- P855: HOTFIX — fn_claim_work_offer 'proposal_id is ambiguous'
--
-- Function returns TABLE(... proposal_id bigint ...), which exposes proposal_id
-- as a PL/pgSQL OUT-parameter variable. The unqualified `proposal_id` in
-- `SELECT id, proposal_id INTO ... FROM candidate` collided with the OUT param,
-- raising SQLSTATE 42702 every claim attempt and disabling the entire
-- pull-based dispatch loop (P289/P433/P744 design).
--
-- Fix: qualify the SELECT with the candidate CTE alias. Function body is
-- otherwise byte-identical to the prior definition.

BEGIN;

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
    v_new_token          uuid        := gen_random_uuid();
    v_expires            timestamptz := now() + make_interval(secs => p_lease_ttl_seconds);
    v_agency_id          bigint;
    v_ceiling_ok         boolean;
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
    -- Qualify with candidate.* — unqualified proposal_id collides with the
    -- function's OUT-parameter of the same name (SQLSTATE 42702).
    SELECT candidate.id, candidate.proposal_id
      INTO v_picked_id, v_picked_proposal_id
      FROM candidate;

    IF v_picked_id IS NULL THEN
        RETURN;
    END IF;

    -- Check proposal-level concurrency ceiling before claiming.
    -- fn_check_concurrency serializes concurrent checks for the same proposal_id
    -- via FOR UPDATE on the per-proposal concurrency_limit row.
    IF v_picked_proposal_id IS NOT NULL THEN
        SELECT ok INTO v_ceiling_ok
        FROM   roadmap_control.fn_check_concurrency('proposal', v_picked_proposal_id::text);

        IF NOT v_ceiling_ok THEN
            -- Ceiling reached — return empty result set.
            -- The picked dispatch row lock (SKIP LOCKED) is released on ROLLBACK/COMMIT.
            RETURN;
        END IF;
    END IF;

    UPDATE roadmap_workforce.squad_dispatch sd
    SET    offer_status    = 'claimed',
           agent_identity  = p_agent_identity,
           claim_token     = v_new_token,
           claim_expires_at = v_expires,
           claimed_at      = now(),
           last_renewed_at = now(),
           offer_version   = sd.offer_version + 1
    WHERE  sd.id = v_picked_id;

    RETURN QUERY
    SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
           sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.id = v_picked_id;
END;
$function$;

COMMIT;
