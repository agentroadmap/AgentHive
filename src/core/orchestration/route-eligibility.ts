/**
 * P928: Shared canonical route-eligibility helper.
 *
 * Extracted from agent-spawner.ts:723-742 for reuse by both resolveActiveRouteProvider
 * and resolveAgencyCurrentRoute. Single source of truth for host-policy filtering +
 * priority/cost ordering.
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
 * Select the first enabled route for a provider on a given host, applying
 * host_model_policy allow/deny filters and ordering by priority ASC, cost ASC.
 *
 * Returns null when no route matches the provider, or all routes are excluded
 * by host policy or disabled.
 *
 * Emits ambiguity warning when multiple rows share the top (priority, cost) tier.
 */
export async function selectActiveRouteRow(
  provider: string,
  hostId: string,
): Promise<ActiveRouteRow | null> {
  const { rows } = await query<ActiveRouteRow>(
    `SELECT mr.id, mr.agent_provider, mr.route_provider, mr.model_name, mr.plan_type,
            mr.cli_path, mr.base_url, mr.priority, mr.cost_per_million_input
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND (
          hp.host_name IS NULL  -- no policy row → allow any (legacy)
          OR (
            (
              coalesce(array_length(hp.allowed_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )
      ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
      LIMIT 1`,
    [provider, hostId],
  );

  if (rows.length === 0) {
    return null;
  }

  const picked = rows[0];

  // P928 + P920: ambiguity warning when the top-N tier has multiple rows.
  // Query all rows at the same priority + cost tier to detect ambiguity.
  const { rows: tierRows } = await query<{ id: number }>(
    `SELECT mr.id
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND mr.priority = $3
        AND COALESCE(mr.cost_per_million_input, 0) = $4
        AND (
          hp.host_name IS NULL
          OR (
            (
              coalesce(array_length(hp.allowed_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )`,
    [provider, hostId, picked.priority, picked.cost_per_million_input ?? 0],
  );

  if (tierRows.length > 1) {
    console.warn(
      `[selectActiveRouteRow] AMBIGUOUS_PROVIDER_ROUTES provider=${provider} host=${hostId} matched=${tierRows.length} picked_route_id=${picked.id}`,
    );
  }

  return picked;
}
