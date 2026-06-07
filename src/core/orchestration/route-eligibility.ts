/**
 * P928: Shared canonical route-eligibility helper.
 *
 * Extracted from agent-spawner.ts:723-742 for reuse by both resolveActiveRouteProvider
 * and resolveAgencyCurrentRoute. Single source of truth for host-policy filtering +
 * priority/cost ordering.
 *
 * P1006: Extended with capability-aware routing via model_capability_profile.
 */

import { query } from "../../infra/postgres/pool.ts";

export interface ActiveRouteRow {
  id: number;
  agent_provider: string;
  route_provider: string;
  model_name: string;
  plan_type: string | null;
  cli_path: string | null;
  base_url: string | null;
  priority: number;
  cost_per_million_input: number | null;
}

/**
 * P1006: Offer requirements for capability-aware routing.
 * When provided, selectActiveRouteRow will filter model candidates by capability scores,
 * tool/vision support, cost tier, and context window.
 */
export interface OfferRequirements {
  min_reasoning_score?: number;
  min_code_quality_score?: number;
  min_instruction_following_score?: number;
  min_context_window_k?: number;
  requires_tool_use?: boolean;
  requires_vision?: boolean;
  max_cost_tier?: number;
  task_category?: string;
}

/**
 * Select the first enabled route for a provider on a given host, applying
 * host_model_policy allow/deny filters and ordering by priority ASC, cost ASC.
 *
 * P1006: When offerRequirements is provided, filters model candidates by:
 * - Capability scores (reasoning, code_quality, instruction_following)
 * - Tool/vision support requirements
 * - Max cost tier constraint
 * - Min context window requirement
 * - Task category spawn requirement (architecture/review require can_spawn_workers=true)
 *
 * Returns null when no route matches the provider, or all routes are excluded
 * by host policy, disabled, or capability constraints.
 *
 * Emits ambiguity warning when multiple rows share the top (priority, cost) tier.
 */
export async function selectActiveRouteRow(
  provider: string,
  hostId: string,
  offerRequirements?: OfferRequirements,
): Promise<ActiveRouteRow | null> {
  // AC-4, AC-13, AC-14: Build capability filter SQL
  let capabilityFilter = "";
  const queryParams: (string | number)[] = [provider, hostId];

  if (offerRequirements) {
    // AC-13: If task category requires spawn capability, filter for can_spawn_workers=true
    if (
      offerRequirements.task_category &&
      ["architecture", "review", "testing", "implementation", "analysis"].includes(
        offerRequirements.task_category,
      )
    ) {
      capabilityFilter += ` AND mcp.can_spawn_workers = true`;
    }

    // AC-14: If task category is architecture or review, only reasoning_score=5 is eligible
    if (offerRequirements.task_category && ["architecture", "review"].includes(offerRequirements.task_category)) {
      capabilityFilter += ` AND mcp.reasoning_score >= 5`;
    }

    // Generic capability score requirements
    if ((offerRequirements.min_reasoning_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_reasoning_score);
      capabilityFilter += ` AND mcp.reasoning_score >= $${queryParams.length}`;
    }

    if ((offerRequirements.min_code_quality_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_code_quality_score);
      capabilityFilter += ` AND mcp.code_quality_score >= $${queryParams.length}`;
    }

    if ((offerRequirements.min_instruction_following_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_instruction_following_score);
      capabilityFilter += ` AND mcp.instruction_following_score >= $${queryParams.length}`;
    }

    if (offerRequirements.requires_tool_use) {
      capabilityFilter += ` AND mcp.supports_tool_use = true`;
    }

    if (offerRequirements.requires_vision) {
      capabilityFilter += ` AND mcp.supports_vision = true`;
    }

    if ((offerRequirements.min_context_window_k ?? 0) > 0) {
      queryParams.push(offerRequirements.min_context_window_k);
      capabilityFilter += ` AND mcp.context_window_k >= $${queryParams.length}`;
    }

    if ((offerRequirements.max_cost_tier ?? 3) < 3) {
      queryParams.push(offerRequirements.max_cost_tier);
      capabilityFilter += ` AND mcp.cost_tier <= $${queryParams.length}`;
    }
  }

  // Build the main query with optional capability JOINs
  const sql = `SELECT mr.id, mr.agent_provider, mr.route_provider, mr.model_name, mr.plan_type,
            mr.cli_path, mr.base_url, mr.priority, mr.cost_per_million_input
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
       ${capabilityFilter.length > 0 ? `LEFT JOIN roadmap_workforce.model_capability_profile mcp ON mcp.provider = mr.route_provider AND mcp.model_name = mr.model_name` : ""}
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND (
          hp.host_name IS NULL  -- no policy row → allow any (legacy)
          OR (
            (
              coalesce(array_length(hp.allowed_route_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_route_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )
        ${capabilityFilter}
      ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
      LIMIT 1`;

  const { rows } = await query<ActiveRouteRow>(sql, queryParams);

  if (rows.length === 0) {
    return null;
  }

  const picked = rows[0];

  // P928 + P920: ambiguity warning when the top-N tier has multiple rows.
  // Query all rows at the same priority + cost tier to detect ambiguity.
  const tierFilterQueryParams = [provider, hostId, picked.priority, picked.cost_per_million_input ?? 0];

  const tierSql = `SELECT mr.id
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
       ${capabilityFilter.length > 0 ? `LEFT JOIN roadmap_workforce.model_capability_profile mcp ON mcp.provider = mr.route_provider AND mcp.model_name = mr.model_name` : ""}
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND mr.priority = $3
        AND COALESCE(mr.cost_per_million_input, 0) = $4
        AND (
          hp.host_name IS NULL
          OR (
            (
              coalesce(array_length(hp.allowed_route_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_route_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )
        ${capabilityFilter}`;

  const { rows: tierRows } = await query<{ id: number }>(tierSql, tierFilterQueryParams);

  if (tierRows.length > 1) {
    console.warn(
      `[selectActiveRouteRow] AMBIGUOUS_PROVIDER_ROUTES provider=${provider} host=${hostId} matched=${tierRows.length} picked_route_id=${picked.id}`,
    );
  }

  return picked;
}
