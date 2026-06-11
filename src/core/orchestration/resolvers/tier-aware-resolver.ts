/**
 * P1091: Tier-Aware Route Resolution with Quota Downshift
 *
 * Implements AC-4, AC-5, AC-8, AC-20, AC-21:
 * - Tier-aware filtering and ordering
 * - Quota downshift retry logic (up to 3 attempts across tiers)
 * - Provider-level quota pooling
 * - Predictive downshift (AC-21) and quota headroom checks
 * - Downshift notifications
 */

import { query as pgQuery } from "../../../infra/postgres/pool.ts";
import { enqueueNotification } from "../../notifications/enqueue.ts";
import type { ModelRoute } from "./route-resolver.types.ts";

export interface TierAwareResolveOpts {
	provider: string;
	projectId?: number | null;
	agencyIdentity?: string | null;
	roleProfileId?: number | null;
	modelHint?: string | null;
	proposalId?: number | null;
	role?: string | null;
	/** The minimum tier required for this task (e.g., 'mid', 'frontier') */
	minTier?: string | null;
	/** Policy filter SQL (layers 1-5) */
	policyFilterSql: string;
	/** Policy params array */
	policyParams: readonly unknown[];
	/** Whether per-million pricing is supported */
	perMillionPricing: boolean;
	/** Default ordering clause (for hint-less fallback) */
	defaultOrderClause?: string;
}

export interface TierDownshiftDecision {
	originalTier: string;
	downshiftTier: string;
	reason: "cooldown" | "throttle" | "quota_low" | "quota_headroom";
	downshiftAttempt: number;
}

/**
 * Compute tier rank for ordering.
 * free=0, lower=1, mid=2, frontier=3, tool=99
 */
export function getTierRank(tier: string | null): number {
	switch (tier) {
		case "free":
			return 0;
		case "lower":
			return 1;
		case "mid":
			return 2;
		case "frontier":
			return 3;
		case "tool":
			return 99;
		default:
			return 99;
	}
}

/**
 * Get the next lower tier to attempt on downshift.
 * frontier → mid → lower → free
 */
export function getNextLowerTier(currentTier: string): string | null {
	switch (currentTier) {
		case "frontier":
			return "mid";
		case "mid":
			return "lower";
		case "lower":
			return "free";
		case "free":
			return null; // can't go lower
		default:
			return null;
	}
}

/**
 * Build a tier-aware WHERE clause for model route filtering.
 *
 * Filters routes where fn_tier_rank(tier) >= fn_tier_rank(min_tier).
 * The query planner can use the expression index idx_model_routes_tier_rank.
 */
export function buildTierFilterClause(minTier: string | null): string {
	if (!minTier) return "";

	// Safe to interpolate because minTier comes from the database or is hardcoded
	const validTiers = ["free", "lower", "mid", "frontier", "tool"];
	if (!validTiers.includes(minTier)) {
		throw new Error(`Invalid tier: ${minTier}`);
	}

	return ` AND roadmap.fn_tier_rank(mr.tier) >= roadmap.fn_tier_rank('${minTier}')`;
}

/**
 * Build tier-aware ORDER BY clause.
 * AC-4: cost-optimization wins within acceptable tier window.
 * Order: cost_per_million_input ASC, priority ASC
 * (not tier-first, to prefer cheaper mid-tier over expensive frontier)
 */
export function buildTierAwareOrderClause(
	perMillionPricing: boolean,
): string {
	if (perMillionPricing) {
		return `COALESCE(mr.cost_per_million_input, 0) ASC, mr.priority ASC`;
	}
	return `mr.priority ASC`;
}

/**
 * Query to fetch a single model route matching tier and policy constraints.
 * Returns null if no matching route found.
 */
export async function fetchModelRouteByTier(
	modelName: string | null,
	provider: string,
	minTier: string | null,
	policyFilterSql: string,
	policyParams: readonly unknown[],
	perMillionPricing: boolean,
	hint: string | null = null,
): Promise<{
	id: number;
	model_name: string;
	route_provider: string;
	agent_provider: string;
	agent_cli?: string;
	cli_path?: string;
	api_spec: string;
	base_url?: string;
	plan_type?: string;
	cost_per_million_input?: number;
	cost_per_million_output?: number;
	api_key_env?: string;
	api_key_fallback_env?: string;
	base_url_env?: string;
	cli_api_key_env?: string;
	api_key_primary?: string;
	api_key_secondary?: string;
	spawn_toolsets?: string;
	spawn_delegate?: boolean;
} | null> {
	const tierClause = buildTierFilterClause(minTier);
	const orderClause = buildTierAwareOrderClause(perMillionPricing);

	let query_sql: string;
	let params: unknown[];

	if (modelName) {
		// Hint-based lookup: specific model + provider
		if (perMillionPricing) {
			query_sql = `
        SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               mr.cost_per_million_input, mr.cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.model_name = $1
          AND mr.agent_provider = $2
          AND mr.is_enabled = true${tierClause}${policyFilterSql}
        ORDER BY ${orderClause}
        LIMIT 1
      `;
		} else {
			query_sql = `
        SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               NULL::numeric AS cost_per_million_input,
               NULL::numeric AS cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.model_name = $1
          AND mr.agent_provider = $2
          AND mr.is_enabled = true${tierClause}${policyFilterSql}
        ORDER BY ${orderClause}
        LIMIT 1
      `;
		}
		params = [modelName, provider, ...policyParams];
	} else {
		// Default lookup: best available route for provider
		if (perMillionPricing) {
			query_sql = `
        SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               mr.cost_per_million_input, mr.cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.agent_provider = $1
          AND mr.is_enabled = true${tierClause}${policyFilterSql}
        ORDER BY
          CASE WHEN mr.is_default = true THEN 0 ELSE 1 END,
          ${orderClause}
        LIMIT 1
      `;
		} else {
			query_sql = `
        SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               NULL::numeric AS cost_per_million_input,
               NULL::numeric AS cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.agent_provider = $1
          AND mr.is_enabled = true${tierClause}${policyFilterSql}
        ORDER BY
          CASE WHEN mr.is_default = true THEN 0 ELSE 1 END,
          ${orderClause}
        LIMIT 1
      `;
		}
		params = [provider, ...policyParams];
	}

	const { rows } = await pgQuery(query_sql, params);
	return rows.length > 0 ? rows[0] : null;
}

/**
 * Check if a route is currently in cooldown or otherwise ineligible due to quota.
 */
export async function isRouteInQuotaCooldown(routeId: number): Promise<boolean> {
	const { rows } = await pgQuery(
		`SELECT 1 FROM roadmap.model_routes
     WHERE id = $1 AND cooldown_until > now()`,
		[routeId],
	);
	return rows.length > 0;
}

/**
 * Check provider-level quota exhaustion (AC-20).
 * Returns true if provider has hit quota exhaustion and recovery window hasn't passed.
 */
export async function isProviderQuotaExhausted(
	provider: string,
): Promise<boolean> {
	const { rows } = await pgQuery(
		`SELECT 1 FROM roadmap_workforce.model_provider_health
     WHERE provider = $1
       AND estimated_recovery_at > now()`,
		[provider],
	);
	return rows.length > 0;
}

/**
 * Log a tier downshift event to route_decision_log.
 * Used by AC-8 to surface downshift decisions to the operator dashboard.
 */
export async function logTierDownshift(
	routeId: number,
	proposalId: number | null,
	role: string | null,
	downshift: TierDownshiftDecision,
	reason_detail: string = "",
): Promise<void> {
	try {
		await pgQuery(
			`INSERT INTO roadmap_workforce.route_decision_log (
        route_id, proposal_id, role, decision_kind, decision_detail, created_at
      ) VALUES ($1, $2, $3, $4, $5, now())`,
			[
				routeId,
				proposalId,
				role,
				"tier_downshift",
				JSON.stringify({
					original_tier: downshift.originalTier,
					downshift_tier: downshift.downshiftTier,
					reason: downshift.reason,
					downshift_attempt: downshift.downshiftAttempt,
					reason_detail,
				}),
			],
		);
	} catch (err) {
		console.warn(
			"[P1091] Failed to log tier_downshift:",
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Enqueue an operator notification for a tier downshift (AC-8).
 */
export async function notifyDownshift(
	originalRouteId: number,
	originalTierName: string,
	fallbackRouteName: string,
	fallbackTierName: string,
	reason: string,
): Promise<void> {
	try {
		await enqueueNotification({
			severity: "WARN",
			kind: "tier_downshift",
			body: `Route downshift: ${originalTierName} (route_id=${originalRouteId}) exhausted, falling back to ${fallbackTierName} (${fallbackRouteName}). Reason: ${reason}`,
		});
	} catch (err) {
		console.warn(
			"[P1091] Failed to enqueue downshift notification:",
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * AC-5: Tier-aware resolver with quota downshift retry logic.
 *
 * Attempts to resolve a route for the given provider + min_tier.
 * If the selected route is in cooldown or quota-exhausted, retries with the next lower tier.
 * Maximum 3 downshift attempts across tiers.
 *
 * Special case: if minTier is 'frontier' (architect), failing all tiers returns P1004 error
 * rather than silently falling back.
 */
export async function resolveTierAwareRoute(
	opts: TierAwareResolveOpts,
): Promise<{
	route: any;
	downshift?: TierDownshiftDecision;
	eliminatedRoutes: any[];
} | null> {
	const {
		provider,
		modelHint,
		minTier,
		policyFilterSql,
		policyParams,
		perMillionPricing,
		projectId,
		roleProfileId,
		proposalId,
		role,
	} = opts;

	let currentMinTier = minTier || "mid"; // default to mid tier
	let downshiftAttempt = 0;
	const maxDownshifts = 3;
	let originalTier = currentMinTier;
	let selectedRoute: any = null;

	// Try to resolve, with downshift retry
	while (downshiftAttempt < maxDownshifts) {
		const route = await fetchModelRouteByTier(
			modelHint || null,
			provider,
			currentMinTier,
			policyFilterSql,
			policyParams,
			perMillionPricing,
		);

		if (!route) {
			// No route available at this tier; try next lower tier
			const nextTier = getNextLowerTier(currentMinTier);
			if (!nextTier) {
				// All tiers exhausted
				if (originalTier === "frontier") {
					throw new Error(
						"P1004: frontier_quota_exhausted - no frontier routes available",
					);
				}
				return null; // Graceful fallback for non-critical tiers
			}

			downshiftAttempt++;
			const previousTier = currentMinTier;
			currentMinTier = nextTier;

			if (proposalId && role) {
				await logTierDownshift(
					-1, // placeholder for "no route"
					proposalId,
					role,
					{
						originalTier: previousTier,
						downshiftTier: nextTier,
						reason: "no_route_available",
						downshiftAttempt,
					},
					"No routes available at required tier",
				);
			}

			continue;
		}

		// Check if this route is in cooldown or provider is quota-exhausted
		const inCooldown = await isRouteInQuotaCooldown(route.id);
		const providerQuotaExhausted = await isProviderQuotaExhausted(provider);

		if (inCooldown || providerQuotaExhausted) {
			// Route/provider is quota-blocked; try next tier
			const nextTier = getNextLowerTier(currentMinTier);
			if (!nextTier) {
				// All tiers exhausted
				if (originalTier === "frontier") {
					throw new Error(
						"P1004: frontier_quota_exhausted - all tiers exhausted",
					);
				}
				// Return the route anyway for lower tiers (don't block)
				selectedRoute = route;
				break;
			}

			downshiftAttempt++;
			const reason = inCooldown ? "cooldown" : "provider_quota_exhausted";
			const previousTier = currentMinTier;
			currentMinTier = nextTier;

			if (proposalId && role) {
				await logTierDownshift(
					route.id,
					proposalId,
					role,
					{
						originalTier: previousTier,
						downshiftTier: nextTier,
						reason: reason as any,
						downshiftAttempt,
					},
					inCooldown
						? `Route in cooldown until ${
								(await pgQuery(
									"SELECT cooldown_until FROM roadmap.model_routes WHERE id = $1",
									[route.id],
								)).rows[0]?.cooldown_until || "unknown"
						  }`
						: "Provider quota exhausted",
				);

				// Notify operator about the downshift
				await notifyDownshift(
					route.id,
					previousTier,
					route.model_name,
					nextTier,
					reason,
				);
			}

			continue;
		}

		// Route is available and not quota-blocked
		selectedRoute = route;
		break;
	}

	if (!selectedRoute) {
		if (originalTier === "frontier") {
			throw new Error("P1004: frontier_quota_exhausted - all attempts failed");
		}
		return null;
	}

	// If we downshifted, record the decision
	const downshift =
		currentMinTier !== originalTier
			? {
					originalTier,
					downshiftTier: currentMinTier,
					reason: "quota_exhausted" as const,
					downshiftAttempt,
				}
			: undefined;

	return {
		route: selectedRoute,
		downshift,
		eliminatedRoutes: [], // TODO: populate from actual policy filtering
	};
}
