/**
 * P3312: Unified Matcher Decision Function
 *
 * matchWorkToRoute(work_item) — pure function returning a ranked candidate list
 * plus four per-candidate axis scores: difficulty-fit, capability, reliability, cost/quota.
 *
 * Phased build (AC-6):
 *   Phase 1 (this PR): pure function skeleton, AC-7 cold-start priors, AC-9 downshift guard.
 *   Phase 2: AC-2/AC-3/AC-4 full reliability filter once P3310+P3311 reach MERGE/COMPLETE.
 *   Stub paths are annotated with "// STUB: awaiting P3310/P3311".
 */

import { getTierRank, getNextLowerTier } from "./resolvers/tier-aware-resolver.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AC-7: minimum observations before trusting the reliability ledger. */
export const MIN_RELIABILITY_SAMPLES = 10;

/** AC-7: cold-start prior reliability by tier when ledger has < MIN_RELIABILITY_SAMPLES. */
export const TIER_RELIABILITY_PRIOR: Record<string, number> = {
	frontier: 0.9,
	mid: 0.7,
	lower: 0.5,
	free: 0.3,
};

/**
 * AC-9 / P3309 AC-4: task classes that must NOT downshift below the reliability
 * floor. Covers BOTH the legacy vocabulary ({merge,architecture}) and the
 * canonical P3310 squad_dispatch vocabulary ({gate_review,mcp_protocol}) so the
 * Haiku-regression guard holds regardless of which classifier produced the
 * task_class. These mirror the is_hard=true rows in reliability_floor for
 * critical (gate/merge/architecture/protocol) work.
 */
export const DOWNSHIFT_LOCKED_TASK_CLASSES: ReadonlySet<string> = new Set([
	// legacy vocabulary
	"gate_review",
	"merge",
	"architecture",
	// canonical P3310 vocabulary (squad_dispatch CHECK)
	"mcp_protocol",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkItem {
	/** Numeric difficulty band produced by P3310 difficulty signal. */
	difficulty: number;
	/** Task classification: 'gate_review' | 'merge' | 'architecture' | 'develop' | etc. */
	task_class: string;
	/** Agent provider preference (e.g. 'claude'). */
	provider?: string | null;
	/** Optional host context for policy filtering. */
	host?: string | null;
	/** Optional project ID for budget/policy layers. */
	projectId?: number | null;
	/** Optional agency identity for agency policy layer. */
	agencyIdentity?: string | null;
	/** Optional role profile ID for role policy layer. */
	roleProfileId?: number | null;
	/** Optional proposal ID for audit logging. */
	proposalId?: number | null;
	/** Optional model hint. */
	modelHint?: string | null;
}

/** Per-candidate reliability cell from P3311 ledger. Stub until P3311 ships. */
export interface ReliabilityCell {
	/** Number of observations for (route_id, task_class). */
	sample_count: number;
	/** Empirical success rate [0, 1]. */
	success_rate: number;
}

/** Route candidate supplied by the capability/policy filter layer (P1068, P1440, P1359). */
export interface RouteCandidate {
	route_id: number;
	model_name: string;
	route_provider: string;
	tier: string;
	cost_per_million_input: number | null;
	priority: number;
}

/** Four-axis score attached to each ranked candidate (AC-1). */
export interface CandidateScores {
	/** 0–1: how well the route's tier matches the item's difficulty. */
	difficulty_fit: number;
	/** 0–1: capability match score (from P1068 profile). STUB until P3311. */
	capability: number;
	/** 0–1: empirical or prior reliability for (route, task_class). */
	reliability: number;
	/** 0–1: inverted cost/quota score; 1=free/cheap, 0=most expensive eligible. */
	cost_quota: number;
}

export interface RankedCandidate extends RouteCandidate {
	scores: CandidateScores;
}

export type NoEligibleRouteReason = "reliability" | "capability" | "quota" | "policy";

export interface NoEligibleRoute {
	kind: "no_eligible_route";
	required_tier: string;
	floor: number;
	missing_axis: NoEligibleRouteReason;
}

export type MatchResult =
	| { kind: "ranked"; candidates: RankedCandidate[] }
	| NoEligibleRoute;

// ---------------------------------------------------------------------------
// Reliability floor derivation (AC-2, AC-3, AC-4)
// ---------------------------------------------------------------------------

/**
 * Map a numeric difficulty score [0–1] to a minimum reliability floor.
 * Higher difficulty → stricter floor.
 */
export function reliabilityFloor(difficulty: number): number {
	if (difficulty >= 0.8) return 0.85;
	if (difficulty >= 0.5) return 0.70;
	if (difficulty >= 0.2) return 0.50;
	return 0.30;
}

/**
 * Derive required tier from difficulty.
 * Returns the tier name whose prior >= reliabilityFloor(difficulty).
 */
export function requiredTierForDifficulty(difficulty: number): string {
	const floor = reliabilityFloor(difficulty);
	if (floor >= 0.85) return "frontier";
	if (floor >= 0.70) return "mid";
	if (floor >= 0.50) return "lower";
	return "free";
}

// ---------------------------------------------------------------------------
// Reliability score lookup (STUB: awaiting P3311)
// ---------------------------------------------------------------------------

/**
 * Fetch reliability cell for a (route_id, task_class) pair.
 *
 * STUB: awaiting P3310/P3311 — returns cold-start prior based on tier.
 * Phase 2: replace with actual SELECT from roadmap_workforce.reliability_ledger.
 */
export async function fetchReliabilityCell(
	_routeId: number,
	_taskClass: string,
	tier: string,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_db?: unknown,
): Promise<ReliabilityCell> {
	// STUB: awaiting P3310/P3311 — return cold-start prior
	return {
		sample_count: 0,
		success_rate: TIER_RELIABILITY_PRIOR[tier] ?? 0.5,
	};
}

/**
 * Get the reliability score for a route, applying the cold-start prior (AC-7)
 * when sample_count < MIN_RELIABILITY_SAMPLES.
 */
export function resolveReliabilityScore(cell: ReliabilityCell, tier: string): number {
	if (cell.sample_count < MIN_RELIABILITY_SAMPLES) {
		// AC-7: cold-start prior
		return TIER_RELIABILITY_PRIOR[tier] ?? 0.5;
	}
	return cell.success_rate;
}

// ---------------------------------------------------------------------------
// Capability score (STUB: awaiting P3310)
// ---------------------------------------------------------------------------

/**
 * Compute capability match score for a candidate against the work item.
 *
 * STUB: awaiting P3310/P3311 — returns 1.0 (all candidates pass capability).
 * Phase 2: query model_capability_profile and score against work item requirements.
 */
export function computeCapabilityScore(
	_candidate: RouteCandidate,
	_item: WorkItem,
): number {
	// STUB: awaiting P3310/P3311
	return 1.0;
}

// ---------------------------------------------------------------------------
// Cost/quota score
// ---------------------------------------------------------------------------

/**
 * Compute normalized cost score [0–1] within a ranked candidate set.
 * 1.0 = cheapest (or free), 0.0 = most expensive.
 */
export function computeCostQuotaScores(candidates: RouteCandidate[]): Map<number, number> {
	const costs = candidates.map((c) => c.cost_per_million_input ?? 0);
	const minCost = Math.min(...costs);
	const maxCost = Math.max(...costs);
	const range = maxCost - minCost;

	const scores = new Map<number, number>();
	for (const c of candidates) {
		const cost = c.cost_per_million_input ?? 0;
		scores.set(c.route_id, range === 0 ? 1.0 : 1.0 - (cost - minCost) / range);
	}
	return scores;
}

// ---------------------------------------------------------------------------
// Difficulty-fit score
// ---------------------------------------------------------------------------

/**
 * Score how well a route's tier fits the item's difficulty requirement.
 * Perfect fit = required tier == route tier → 1.0.
 * Over-provisioned (route tier > required) → partial score (acceptable but costly).
 * Under-provisioned (route tier < required) → 0.0 (should be filtered out).
 */
export function computeDifficultyFitScore(routeTier: string, requiredTier: string): number {
	const routeRank = getTierRank(routeTier);
	const requiredRank = getTierRank(requiredTier);
	if (routeRank < requiredRank) return 0.0; // under-provisioned
	if (routeRank === requiredRank) return 1.0; // perfect fit
	// over-provisioned: penalize by tier gap to prefer cheaper options
	const gap = routeRank - requiredRank;
	return Math.max(0.5, 1.0 - gap * 0.15);
}

// ---------------------------------------------------------------------------
// Core: matchWorkToRoute (AC-1)
// ---------------------------------------------------------------------------

/**
 * AC-1: Pure, testable function returning a ranked candidate list plus four
 * per-candidate axis scores: difficulty-fit, capability, reliability, cost/quota.
 *
 * No side effects. All DB reads are dependency-injected for testability.
 *
 * AC-2 (Phase 2): When P3310+P3311 are COMPLETE, replace stub fetchReliabilityCell
 * with real ledger queries and replace computeCapabilityScore stub with profile queries.
 */
export async function matchWorkToRoute(
	item: WorkItem,
	candidates: RouteCandidate[],
	opts?: {
		fetchReliability?: (routeId: number, taskClass: string, tier: string) => Promise<ReliabilityCell>;
	},
): Promise<MatchResult> {
	const fetchRel = opts?.fetchReliability ?? fetchReliabilityCell;

	const floor = reliabilityFloor(item.difficulty);
	const requiredTier = requiredTierForDifficulty(item.difficulty);

	if (candidates.length === 0) {
		return {
			kind: "no_eligible_route",
			required_tier: requiredTier,
			floor,
			missing_axis: "policy",
		};
	}

	// Score each candidate across all four axes
	const reliabilityCells = await Promise.all(
		candidates.map((c) => fetchRel(c.route_id, item.task_class, c.tier)),
	);

	const costScores = computeCostQuotaScores(candidates);

	const scored: Array<{ candidate: RouteCandidate; scores: CandidateScores; reliability: number }> =
		candidates.map((c, i) => {
			const cell = reliabilityCells[i];
			const reliability = resolveReliabilityScore(cell, c.tier);
			const scores: CandidateScores = {
				difficulty_fit: computeDifficultyFitScore(c.tier, requiredTier),
				capability: computeCapabilityScore(c, item),
				reliability,
				cost_quota: costScores.get(c.route_id) ?? 0,
			};
			return { candidate: c, scores, reliability };
		});

	// AC-2: retain only candidates passing reliability floor
	// STUB: awaiting P3310/P3311 — filter is applied but uses prior-based reliability
	const eligible = scored.filter(
		(s) => s.reliability >= floor && s.scores.capability > 0,
	);

	if (eligible.length === 0) {
		// AC-4: attempt tier downshift/upshift
		const downshiftResult = await applyDownshift(item, candidates, scored, floor, requiredTier, fetchRel);
		if (downshiftResult) return downshiftResult;

		// AC-9: no_eligible_route with structured evidence
		return {
			kind: "no_eligible_route",
			required_tier: requiredTier,
			floor,
			missing_axis: "reliability",
		};
	}

	// Rank survivors cheapest-first (AC-2: cheapest-first among passing candidates)
	eligible.sort((a, b) => {
		const aCost = a.candidate.cost_per_million_input ?? 0;
		const bCost = b.candidate.cost_per_million_input ?? 0;
		if (aCost !== bCost) return aCost - bCost;
		return a.candidate.priority - b.candidate.priority;
	});

	return {
		kind: "ranked",
		candidates: eligible.map((s) => ({ ...s.candidate, scores: s.scores })),
	};
}

// ---------------------------------------------------------------------------
// Downshift logic (AC-4, AC-9)
// ---------------------------------------------------------------------------

/**
 * AC-4: Reliability-aware tier downshift.
 * When no candidate clears the floor at the required tier, step down the
 * difficulty band using P1091 tier_rank rules — UNLESS task_class is locked.
 *
 * AC-9: DOWNSHIFT_LOCKED_TASK_CLASSES prevents downshift for critical task classes.
 */
async function applyDownshift(
	item: WorkItem,
	candidates: RouteCandidate[],
	scored: Array<{ candidate: RouteCandidate; scores: CandidateScores; reliability: number }>,
	_originalFloor: number,
	requiredTier: string,
	fetchRel: (routeId: number, taskClass: string, tier: string) => Promise<ReliabilityCell>,
): Promise<MatchResult | null> {
	// AC-9: locked classes must not downshift
	if (DOWNSHIFT_LOCKED_TASK_CLASSES.has(item.task_class)) {
		return null; // caller will emit no_eligible_route with missing_axis='reliability'
	}

	let currentTier = requiredTier;
	const maxDownshifts = 3;

	for (let attempt = 0; attempt < maxDownshifts; attempt++) {
		const nextTier = getNextLowerTier(currentTier);
		if (!nextTier) break;

		currentTier = nextTier;
		const newFloor = reliabilityFloor(difficultyForTier(currentTier));
		const costScores = computeCostQuotaScores(candidates);

		// Re-score with new floor
		const rescored = await Promise.all(
			candidates.map(async (c) => {
				const cell = await fetchRel(c.route_id, item.task_class, c.tier);
				const reliability = resolveReliabilityScore(cell, c.tier);
				const scores: CandidateScores = {
					difficulty_fit: computeDifficultyFitScore(c.tier, currentTier),
					capability: computeCapabilityScore(c, item),
					reliability,
					cost_quota: costScores.get(c.route_id) ?? 0,
				};
				return { candidate: c, scores, reliability };
			}),
		);

		const eligible = rescored.filter((s) => s.reliability >= newFloor && s.scores.capability > 0);
		if (eligible.length === 0) continue;

		eligible.sort((a, b) => {
			const aCost = a.candidate.cost_per_million_input ?? 0;
			const bCost = b.candidate.cost_per_million_input ?? 0;
			if (aCost !== bCost) return aCost - bCost;
			return a.candidate.priority - b.candidate.priority;
		});

		return {
			kind: "ranked",
			candidates: eligible.map((s) => ({ ...s.candidate, scores: s.scores })),
		};
	}

	return null;
}

/** Reverse-map a tier name to a representative difficulty value for floor calculation. */
function difficultyForTier(tier: string): number {
	switch (tier) {
		case "frontier": return 0.9;
		case "mid": return 0.6;
		case "lower": return 0.3;
		case "free": return 0.1;
		default: return 0.5;
	}
}
