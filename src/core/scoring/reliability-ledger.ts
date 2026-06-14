/**
 * P3311 (Child B of P3309): Reliability ledger read API.
 *
 * Exposes the per-(scope × task_class) reliability score to the Child C
 * matcher (P3312). The matcher consumes two shapes:
 *
 *   getReliability(candidate, taskClass) → { score, confidence, sample_count }
 *       — the clean, documented Child-C entry point.
 *
 *   fetchReliabilityCell(routeId, taskClass, tier, db?) → ReliabilityCell
 *       — a DROP-IN replacement for the stub of the same name/signature in
 *         match-work-to-route.ts (P3312). Returns { sample_count, success_rate }.
 *
 * Both read from roadmap_workforce.reliability_score via the migration-269
 * hierarchical-fallback function fn_p3311_reliability_lookup(), which applies
 * the task_class → task_family → _global cold-start chain in SQL. The TS layer
 * adds tier-prior blending for the truly-cold (zero-sample) case.
 *
 * DEPENDENCY (Child A / P3310): per-class cells only populate once P3310 stamps
 * squad_dispatch.task_class. Until then the lookup resolves to the '_global'
 * cell per scope, which is correct (class-agnostic) behaviour.
 */

import { confidenceFor, resolveColdStart, type Confidence } from "./reliability-math.ts";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type ScopeType = "model" | "agency" | "route";

/** A candidate to score. Carries whichever scope key(s) are known. */
export interface ReliabilityCandidate {
	scopeType: ScopeType;
	/** model_used | agency_identity | route_id (as text). */
	scopeKey: string;
	/** Cold-start tier prior (e.g. from match-work-to-route TIER_RELIABILITY_PRIOR). */
	tierPrior?: number;
}

/** Clean Child-C result shape. */
export interface ReliabilityResult {
	score: number;
	confidence: Confidence;
	sample_count: number;
	effective_sample_count: number;
	/** Which fallback level produced the score. */
	resolved_level: "exact" | "family" | "global" | "prior";
}

/**
 * Drop-in shape matching match-work-to-route.ts `ReliabilityCell` (P3312).
 * Keep these field names byte-for-byte identical to that interface.
 */
export interface ReliabilityCell {
	sample_count: number;
	success_rate: number;
}

/** Minimal row returned by fn_p3311_reliability_lookup. */
interface LookupRow {
	score: string | number | null;
	effective_sample_count: string | number | null;
	sample_count: number | null;
	resolved_task_class: string | null;
	fallback_level: "exact" | "family" | "global" | null;
}

/**
 * Injectable query function — defaults to the control-plane pool's query() but
 * is overridable in tests with an in-memory fake (no live DB).
 */
export type QueryFn = <T = any>(text: string, params?: any[]) => Promise<{ rows: T[] }>;

let defaultQuery: QueryFn | null = null;

async function getDefaultQuery(): Promise<QueryFn> {
	if (!defaultQuery) {
		const { query } = await import("../../infra/postgres/pool.ts");
		defaultQuery = query as unknown as QueryFn;
	}
	return defaultQuery;
}

const DEFAULT_MIN_SAMPLES = 5;
const NEUTRAL_PRIOR = 0.5;

// ---------------------------------------------------------------------------
// Core read API (AC-4)
// ---------------------------------------------------------------------------

/**
 * Return the reliability score + confidence for a (candidate, task_class).
 *
 * Resolution order (cold-start hierarchical fallback, AC-2):
 *   exact task_class cell → task_family aggregate → scope _global → tier prior.
 * The SQL function returns up to one row per level; we take the strongest level
 * meeting the minimum-sample bar, else blend toward the tier prior.
 */
export async function getReliability(
	candidate: ReliabilityCandidate,
	taskClass: string,
	opts?: { query?: QueryFn; minSamples?: number },
): Promise<ReliabilityResult> {
	const q = opts?.query ?? (await getDefaultQuery());
	const minSamples = opts?.minSamples ?? DEFAULT_MIN_SAMPLES;
	const tierPrior = candidate.tierPrior ?? NEUTRAL_PRIOR;

	const { rows } = await q<LookupRow>(
		"SELECT score, effective_sample_count, sample_count, resolved_task_class, fallback_level " +
			"FROM roadmap_workforce.fn_p3311_reliability_lookup($1, $2, $3)",
		[candidate.scopeType, candidate.scopeKey, taskClass],
	);

	const byLevel = (lvl: "exact" | "family" | "global") => {
		const r = rows.find((x) => x.fallback_level === lvl);
		if (!r || r.score == null) return null;
		return {
			score: Number(r.score),
			effectiveSampleCount: Number(r.effective_sample_count ?? 0),
			sampleCount: Number(r.sample_count ?? 0),
		};
	};

	const resolved = resolveColdStart(
		{ exact: byLevel("exact"), family: byLevel("family"), global: byLevel("global") },
		tierPrior,
		minSamples,
	);

	// Carry through the raw counts of the winning level for the caller.
	const winning =
		resolved.level === "exact"
			? byLevel("exact")
			: resolved.level === "family"
				? byLevel("family")
				: resolved.level === "global"
					? byLevel("global")
					: (byLevel("exact") ?? byLevel("family") ?? byLevel("global"));

	return {
		score: resolved.score,
		confidence: resolved.confidence,
		sample_count: winning?.sampleCount ?? 0,
		effective_sample_count: winning?.effectiveSampleCount ?? 0,
		resolved_level: resolved.level,
	};
}

// ---------------------------------------------------------------------------
// P3312 drop-in adapter
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for match-work-to-route.ts `fetchReliabilityCell` stub.
 * Signature and return shape match exactly so P3312 can swap the import:
 *   (routeId, taskClass, tier, db?) → { sample_count, success_rate }.
 *
 * `tier` is unused for the empirical lookup (the matcher applies its own
 * TIER_RELIABILITY_PRIOR cold-start via resolveReliabilityScore); we surface
 * the empirical success_rate + sample_count and let the matcher decide.
 */
export async function fetchReliabilityCell(
	routeId: number,
	taskClass: string,
	_tier: string,
	db?: QueryFn,
): Promise<ReliabilityCell> {
	const res = await getReliability(
		{ scopeType: "route", scopeKey: String(routeId) },
		taskClass,
		{ query: db },
	);
	return {
		sample_count: res.sample_count,
		success_rate: res.score,
	};
}

/** Re-export for callers that want the confidence mapping directly. */
export { confidenceFor };
