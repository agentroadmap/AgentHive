-- P1068 AC-6: Domain fallback matching helper for role resolution
--
-- When matching agent capabilities to required roles, implement a fallback strategy:
-- 1. Exact match: agent has the exact role_slug (weight = 1.0)
-- 2. Domain match: agent has any role in the same domain (weight = 0.5)
--
-- Example:
--   Agent has: engineering/code-reviewer, engineering/architect
--   Required: engineering/security-auditor
--   Result: DOMAIN MATCH (0.5 weight) on "engineering/*"

-- Helper function to extract domain from a role slug (e.g., "engineering/code-reviewer" -> "engineering")
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_role_domain(p_role_slug text)
RETURNS text LANGUAGE plpgsql STABLE AS $function$
BEGIN
  IF p_role_slug IS NULL OR p_role_slug NOT LIKE '%/%' THEN
    RETURN NULL;  -- No domain prefix
  END IF;
  RETURN split_part(p_role_slug, '/', 1);
END;
$function$;

-- Helper function to check if an agent has a required capability
-- Returns a score: 1.0 for exact match, 0.5 for domain match, NULL for no match
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_match_capability(
  p_agent_slug text,
  p_required_role_slug text
)
RETURNS numeric LANGUAGE plpgsql STABLE AS $function$
DECLARE
  v_exact_match BOOLEAN;
  v_domain_match BOOLEAN;
  v_required_domain text;
BEGIN
  -- Check for exact match in agent_capability table
  SELECT EXISTS(
    SELECT 1 FROM roadmap_proposal.agent_capability ac
    WHERE ac.agency_slug = p_agent_slug
      AND ac.role_slug = p_required_role_slug
      AND (SELECT is_active FROM roadmap_proposal.capability_taxonomy ct WHERE ct.role_slug = ac.role_slug)
  ) INTO v_exact_match;

  IF v_exact_match THEN
    RETURN 1.0;  -- Exact match has full weight
  END IF;

  -- AC-6: Check for domain fallback match
  -- Extract domain from required role (e.g., "engineering/code-reviewer" -> "engineering")
  v_required_domain := roadmap_proposal.fn_role_domain(p_required_role_slug);

  IF v_required_domain IS NOT NULL THEN
    -- Check if agent has ANY role in the same domain
    SELECT EXISTS(
      SELECT 1 FROM roadmap_proposal.agent_capability ac
      INNER JOIN roadmap_proposal.capability_taxonomy ct ON ac.role_slug = ct.role_slug
      WHERE ac.agency_slug = p_agent_slug
        AND ct.domain = v_required_domain
        AND ct.is_active = true
    ) INTO v_domain_match;

    IF v_domain_match THEN
      RETURN 0.5;  -- Domain match has half weight (lower priority)
    END IF;
  END IF;

  RETURN NULL;  -- No match at any level
END;
$function$;

-- Note: agent_capability already has indexes on agency_slug and role_slug
-- Domain-based filtering is handled by fn_match_capability joining with capability_taxonomy
