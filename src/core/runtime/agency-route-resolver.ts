/**
 * P928: Agency-scoped route resolver for self-registration.
 *
 * Resolves the model_route that an agency is currently bound to via
 * selectActiveRouteRow. Used by selfRegisterAgency to write current_route_id
 * into agent_registry on every boot.
 */

import {
  selectActiveRouteRow,
  type ActiveRouteRow,
} from "../orchestration/route-eligibility.ts";

/**
 * The full route row bound to an agency, returned by resolveAgencyCurrentRoute.
 * Includes all fields needed for display (route_provider, model_name, plan_type)
 * and backend invocation (base_url, cli_path).
 */
export interface AgencyCurrentRoute extends ActiveRouteRow {}

/**
 * Resolve the model_route an agency is currently bound to.
 *
 * Returns the full route row (including id, route_provider, model_name, plan_type)
 * so the caller can write current_route_id into agent_registry and access route
 * metadata for display rendering.
 *
 * Returns null if no enabled route matches the provider or all routes are excluded
 * by host policy.
 */
export async function resolveAgencyCurrentRoute(
  provider: string,
  hostId: string,
): Promise<AgencyCurrentRoute | null> {
  return selectActiveRouteRow(provider, hostId);
}
