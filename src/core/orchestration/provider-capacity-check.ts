/**
 * V3-C8 (P1440) AC-2: Provider Capacity Pre-Check
 *
 * Before posting or claiming a work offer, verify that the provider route
 * has sufficient capacity:
 *   - Auth is not down (auth_down_until IS NULL or <= now())
 *   - Not in cooldown (cooldown_until IS NULL or <= now())
 *   - Token budget not exhausted (if applicable)
 *
 * This prevents wasting orchestrator effort on routes that are known to be
 * unavailable. Routes that become unavailable mid-flight are handled by
 * the provider-cooldown retry logic (P1359).
 *
 * Returns { sufficient: boolean, reason?: string } for explicit escalation.
 */

import { query } from "../../infra/postgres/pool.ts";

export interface ProviderCapacityCheckResult {
  /** true if the provider is available for offer posting/claiming */
  sufficient: boolean;
  /** Reason why capacity is insufficient (for escalation log) */
  reason?: string;
  /** Provider state snapshot (for diagnostics) */
  authDownUntil?: Date | null;
  cooldownUntil?: Date | null;
  tokenBudgetRemaining?: number | null;
}

/**
 * Check if a provider route has sufficient capacity for new work.
 *
 * @param routeId The model_routes.id of the route to check
 * @returns Capacity check result with sufficiency flag and reason if insufficient
 */
export async function isProviderCapacitySufficient(
  routeId: bigint | number,
): Promise<ProviderCapacityCheckResult> {
  const { rows } = await query<{
    auth_down_until: Date | null;
    cooldown_until: Date | null;
    token_budget_remaining: number | null;
    route_provider: string;
  }>(
    `SELECT
      mr.auth_down_until,
      mr.cooldown_until,
      COALESCE(mr.token_budget_remaining, mr.token_budget_hourly) AS token_budget_remaining,
      mr.route_provider
     FROM roadmap.model_routes mr
     WHERE mr.id = $1
     LIMIT 1`,
    [routeId],
  );

  if (!rows.length) {
    return {
      sufficient: false,
      reason: "Route not found in model_routes",
    };
  }

  const route = rows[0];

  // Check auth_down_until (from C3 auth-down feature)
  if (route.auth_down_until && route.auth_down_until > new Date()) {
    return {
      sufficient: false,
      reason: `Provider auth is down until ${route.auth_down_until.toISOString()}`,
      authDownUntil: route.auth_down_until,
    };
  }

  // Check cooldown_until (from P1359 provider quota cooldown)
  if (route.cooldown_until && route.cooldown_until > new Date()) {
    return {
      sufficient: false,
      reason: `Provider in cooldown until ${route.cooldown_until.toISOString()}`,
      cooldownUntil: route.cooldown_until,
    };
  }

  // Check token budget if tracked
  if (
    route.token_budget_remaining !== null &&
    route.token_budget_remaining <= 0
  ) {
    return {
      sufficient: false,
      reason: `Token budget exhausted for provider ${route.route_provider}`,
      tokenBudgetRemaining: route.token_budget_remaining,
    };
  }

  return {
    sufficient: true,
    authDownUntil: route.auth_down_until,
    cooldownUntil: route.cooldown_until,
    tokenBudgetRemaining: route.token_budget_remaining,
  };
}

/**
 * Check multiple routes in parallel and return only the sufficient ones.
 * Useful for filtering a list of eligible routes before offer posting.
 */
export async function filterSufficientRoutes(
  routeIds: (bigint | number)[],
): Promise<Map<bigint | number, ProviderCapacityCheckResult>> {
  const results = new Map<bigint | number, ProviderCapacityCheckResult>();

  const checks = routeIds.map((id) =>
    isProviderCapacitySufficient(id).then((result) => ({
      id,
      result,
    })),
  );

  const completed = await Promise.allSettled(checks);

  for (const settlement of completed) {
    if (settlement.status === "fulfilled") {
      const { id, result } = settlement.value;
      results.set(id, result);
    }
  }

  return results;
}
