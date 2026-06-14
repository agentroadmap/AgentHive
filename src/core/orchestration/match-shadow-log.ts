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
 * P3309 INTEGRATION (umbrella): the P3310 difficulty signal and the P3311
 * reliability ledger are now MERGED on main. This module composes them:
 *   - difficulty + task_class come from P3310 assessDifficulty() (real, not tier-derived).
 *   - reliability comes from P3311 fetchReliabilityCell() (real ledger read with
 *     AC-7 cold-start fallback), injected as matchWorkToRoute's default
 *     `fetchReliability` so the matcher scores against the live ledger.
 * The provisional* helpers are RETAINED as deterministic fallbacks (and for the
 * existing unit contract) but are no longer the primary signal path.
 */

import { query } from "../../infra/postgres/pool.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import {
	assessDifficulty,
	type CapabilityTier,
} from "./difficulty-assessor.ts";
import { fetchReliabilityCell as ledgerFetchReliabilityCell } from "../scoring/reliability-ledger.ts";
import {
	type MatchResult,
	matchWorkToRoute,
	type ReliabilityCell,
	type RouteCandidate,
	type WorkItem,
} from "./match-work-to-route.ts";

/**
 * P3311 reliability read-API — the Child-B contract. The umbrella keeps this
 * thin interface so callers (and tests) can inject an alternate reliability
 * source. When omitted, computeShadowLog wires P3311's real ledger reader
 * (fetchReliabilityCell) directly. See AC-1 (single source consulted by both paths).
 */
export interface ReliabilityReadApi {
	/** Returns reliability for a (route, task_class) cell. */
	getReliability(
		routeId: number,
		taskClass: string,
	): Promise<{ score: number; confidence: number }>;
}

/**
 * Deterministic fallback: derive a difficulty [0,1] from the legacy requiredTier
 * hint. Retained for the case where assessDifficulty cannot be consulted; the
 * primary path now uses the P3310 assessor (see deriveWorkSignal).
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
 * Deterministic fallback: derive a task_class from the workflow role label using
 * the legacy {gate_review,merge,architecture,develop} vocabulary. The primary
 * path now uses P3310 classifyTaskClass via assessDifficulty (canonical
 * {mcp_protocol,code_dev,gate_review,triage,mechanical,research} vocabulary).
 */
export function provisionalTaskClass(role: string | null): string {
	const r = (role ?? "").toLowerCase();
	if (r.includes("gate") || r.includes("review")) return "gate_review";
	if (r.includes("merge")) return "merge";
	if (r.includes("architect")) return "architecture";
	return "develop";
}

/**
 * P3309 wire-point: compose the P3310 difficulty signal into the matcher's
 * WorkItem dimensions. Uses the canonical assessDifficulty(role) → {difficulty,
 * task_class, requiredCapabilityTier}. Pure (no I/O); role is the only signal
 * available at the resolver call-site, so task text/AC-count are left unset and
 * the assessor falls back to its role-based heuristic.
 */
export function deriveWorkSignal(role: string | null): {
	difficulty: number;
	task_class: string;
	requiredCapabilityTier: CapabilityTier;
} {
	const a = assessDifficulty({ role: role ?? "" });
	return {
		difficulty: a.difficultyScore,
		task_class: a.taskClass,
		requiredCapabilityTier: a.requiredCapabilityTier,
	};
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
	/** P3309: composed axis signals, surfaced for the route_decision_log columns. */
	task_class: string | null;
	difficulty_score: number | null;
	/** Reliability of the legacy-chosen route for this task_class (ledger or prior). */
	reliability_score: number | null;
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

	// P3310: real difficulty + canonical task_class from the merged assessor.
	const signal = deriveWorkSignal(input.role);

	let matcher_choice: MatchResult | null = null;
	let reliability_score: number | null = null;
	try {
		const candidates = await fetchCandidatePool(input.provider, input.host);
		const item: WorkItem = {
			difficulty: signal.difficulty,
			task_class: signal.task_class,
			provider: input.provider,
			host: input.host,
			projectId: input.projectId,
			agencyIdentity: input.agencyIdentity,
		};

		// P3309 wiring: the matcher's reliability source. Precedence:
		//   1. caller-injected ReliabilityReadApi (tests / alternate sources)
		//   2. P3311's real ledger reader fetchReliabilityCell (default)
		// Either way the matcher applies AC-7 cold-start priors when the ledger
		// returns < MIN_RELIABILITY_SAMPLES observations.
		const fetchReliability: (
			routeId: number,
			taskClass: string,
			tier: string,
		) => Promise<ReliabilityCell> = reliabilityApi
			? async (routeId, taskClass, _tier) => {
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
			: (routeId, taskClass, tier) =>
					// Pass this module's `query` (the same one fetchCandidatePool uses,
					// and the one mocked in unit tests) so the ledger read shares the
					// connection/mocking surface instead of a private dynamic import.
					ledgerFetchReliabilityCell(routeId, taskClass, tier, query);

		matcher_choice = await matchWorkToRoute(item, candidates, { fetchReliability });

		// Surface the reliability of the LEGACY-chosen route for the log column.
		const chosenTier =
			candidates.find((c) => c.route_id === input.chosenRouteId)?.tier ??
			input.requiredTier ??
			"mid";
		const chosenCell = await fetchReliability(
			input.chosenRouteId,
			signal.task_class,
			chosenTier,
		).catch(() => null);
		reliability_score = chosenCell ? chosenCell.success_rate : null;
	} catch {
		// Shadow logging is best-effort; never block or alter routing on failure.
		matcher_choice = null;
	}

	return {
		matcher_choice,
		legacy_choice: shadowMode ? legacy_choice : null,
		shadow_mode: shadowMode,
		task_class: signal.task_class,
		difficulty_score: signal.difficulty,
		reliability_score,
	};
}
