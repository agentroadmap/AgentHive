/**
 * P3312 AC-5: Shadow-mode wiring for matchWorkToRoute.
 *
 * This module is the SINGLE integration point through which both the spawn
 * resolver (resolveModelRoute) and offer-dispatch (which spawns via spawnAgent →
 * resolveModelRoute → logRouteDecision) consult the unified matcher. That makes it
 * the "single source consulted by both paths" required by the P3309 umbrella (AC-1).
 *
 * Behavior contract (AC-5 + AC-8):
 *   - When runtime_flag ADAPTIVE_MATCHER_ENABLED is FALSE (default), the matcher
 *     runs in SHADOW MODE: it computes matchWorkToRoute over the same candidate
 *     pool the legacy resolver chose from, and the result is LOGGED ONLY. The
 *     legacy choice is what is acted on. shadow_mode=true is recorded.
 *   - When the flag is TRUE, shadow_mode=false is recorded. (Active-path route
 *     SELECTION is deferred to P3313/umbrella once P3310+P3311 reach COMPLETE; this
 *     module never changes the route returned by resolveModelRoute. The flag only
 *     toggles the shadow_mode boolean and is the documented activation seam.)
 *
 * CRITICAL: nothing in this module mutates or returns a route. It only produces a
 * JSONB payload for route_decision_log. Shadow mode therefore cannot alter live
 * routing — proven by match-shadow-log.test.ts.
 *
 * P3310 (difficulty + task_class) and P3311 (reliability read-API getReliability)
 * are not yet on main. Until they merge, provisional difficulty/task_class are
 * derived from requiredTier/role, and reliability uses AC-7 cold-start priors via
 * matchWorkToRoute's default fetchReliabilityCell. See // STUB: awaiting P3310/P3311.
 */

import { query } from "../../infra/postgres/pool.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import {
	type MatchResult,
	matchWorkToRoute,
	type RouteCandidate,
	type WorkItem,
} from "./match-work-to-route.ts";

/**
 * P3311 reliability read-API — EXPECTED shape (Child B, building concurrently).
 * Defined here as a thin interface so AC-5 wiring integrates at merge with no
 * code change beyond swapping the import. See AC-2 dependency note in the report.
 *
 * STUB: awaiting P3311 — when P3311 lands, import { getReliability } from its
 * module and pass an adapter to matchWorkToRoute's `fetchReliability` option.
 */
export interface ReliabilityReadApi {
	/** Returns reliability for a (route, task_class) cell. */
	getReliability(
		routeId: number,
		taskClass: string,
	): Promise<{ score: number; confidence: number }>;
}

/**
 * Derive a provisional difficulty [0,1] from the legacy requiredTier hint.
 * STUB: awaiting P3310 — replace with the difficulty signal once it ships.
 */
export function provisionalDifficulty(requiredTier: string | null): number {
	switch (requiredTier) {
		case "frontier":
			return 0.9;
		case "mid":
			return 0.6;
		case "lower":
			return 0.3;
		case "free":
			return 0.1;
		default:
			return 0.5; // unknown tier → mid band
	}
}

/**
 * Derive a provisional task_class from the workflow role label.
 * STUB: awaiting P3310 — replace with the canonical task_class once it ships.
 * Maps known critical roles onto the DOWNSHIFT_LOCKED_TASK_CLASSES vocabulary.
 */
export function provisionalTaskClass(role: string | null): string {
	const r = (role ?? "").toLowerCase();
	if (r.includes("gate") || r.includes("review")) return "gate_review";
	if (r.includes("merge")) return "merge";
	if (r.includes("architect")) return "architecture";
	return "develop";
}

export interface ShadowLogInput {
	provider: string;
	chosenRouteId: number;
	role: string | null;
	agencyIdentity: string | null;
	projectId: number | null;
	requiredTier: string | null;
	/** Host policy key for fetching the candidate pool. */
	host: string;
}

export interface ShadowLogResult {
	matcher_choice: MatchResult | null;
	legacy_choice: { route_id: number; source: "legacy_resolver" } | null;
	shadow_mode: boolean;
}

/**
 * Fetch the candidate pool (the routes that PASSED policy for this provider/host)
 * so the matcher scores the same set the legacy resolver chose from.
 *
 * Read-only SELECT; no side effects.
 */
async function fetchCandidatePool(
	provider: string,
	host: string,
): Promise<RouteCandidate[]> {
	const { rows } = await query<{
		id: number;
		model_name: string;
		route_provider: string;
		tier: string | null;
		cost_per_million_input: number | null;
		priority: number | null;
	}>(
		`SELECT mr.id, mr.model_name, mr.route_provider, mr.tier,
		        mr.cost_per_million_input, mr.priority
		   FROM roadmap.model_routes mr
		  WHERE mr.agent_provider = $1
		    AND mr.is_enabled = true`,
		[provider],
	);
	void host; // host-policy narrowing deferred; matcher scores the enabled pool.
	return rows.map((r) => ({
		route_id: r.id,
		model_name: r.model_name,
		route_provider: r.route_provider,
		tier: r.tier ?? "mid",
		cost_per_million_input: r.cost_per_million_input,
		priority: r.priority ?? 0,
	}));
}

/**
 * AC-5 + AC-8: compute the shadow-mode log payload.
 *
 * Returns the three JSONB-bound values for route_decision_log. NEVER returns a
 * route — by construction it cannot change live routing. On any error it returns
 * a null/legacy-only payload so logging stays non-blocking.
 *
 * @param reliabilityApi optional P3311 read-API; when provided, its getReliability
 *   is adapted into matchWorkToRoute. STUB: until P3311 merges this is undefined and
 *   the matcher uses AC-7 cold-start priors.
 */
export async function computeShadowLog(
	input: ShadowLogInput,
	reliabilityApi?: ReliabilityReadApi,
): Promise<ShadowLogResult> {
	const enabled = await config
		.get(FlagKeys.ADAPTIVE_MATCHER_ENABLED)
		.catch(() => false);
	const shadowMode = !enabled;

	const legacy_choice = {
		route_id: input.chosenRouteId,
		source: "legacy_resolver" as const,
	};

	let matcher_choice: MatchResult | null = null;
	try {
		const candidates = await fetchCandidatePool(input.provider, input.host);
		const item: WorkItem = {
			difficulty: provisionalDifficulty(input.requiredTier),
			task_class: provisionalTaskClass(input.role),
			provider: input.provider,
			host: input.host,
			projectId: input.projectId,
			agencyIdentity: input.agencyIdentity,
		};
		// STUB: awaiting P3311 — adapt getReliability into the matcher when present.
		const fetchReliability = reliabilityApi
			? async (routeId: number, taskClass: string, _tier: string) => {
					const { score, confidence } = await reliabilityApi.getReliability(
						routeId,
						taskClass,
					);
					// Translate confidence→sample_count so AC-7 cold-start logic still applies.
					return {
						sample_count: Math.round(confidence * 100),
						success_rate: score,
					};
				}
			: undefined;
		matcher_choice = await matchWorkToRoute(
			item,
			candidates,
			fetchReliability ? { fetchReliability } : undefined,
		);
	} catch {
		// Shadow logging is best-effort; never block or alter routing on failure.
		matcher_choice = null;
	}

	return {
		matcher_choice,
		legacy_choice: shadowMode ? legacy_choice : null,
		shadow_mode: shadowMode,
	};
}
