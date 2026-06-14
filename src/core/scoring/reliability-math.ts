/**
 * P3311 (Child B of P3309): Reliability scoring math.
 *
 * Pure, DB-free functions for the per-(scope × task_class) reliability ledger:
 *   - Beta-Bernoulli posterior (AC-5, per P1070 — NOT re-derived; standard
 *     conjugate prior for a success/failure Bernoulli process).
 *   - Exponential time-decay weighting.
 *   - Distinct failure-class weighting (AC-3).
 *   - Cold-start hierarchical fallback resolution (AC-2).
 *
 * The SQL rollup (migration 269) mirrors this exact math server-side; this
 * module is the canonical, testable specification and is reused by the read
 * API for cold-start prior blending.
 */

// ---------------------------------------------------------------------------
// Outcome taxonomy (AC-3)
// ---------------------------------------------------------------------------

/** Coarse outcome of a single agent_run, in increasing severity of penalty. */
export type RunOutcome =
	| "success"
	| "rework" // transient / re-attemptable (e.g. rate_limited) — mild penalty
	| "mismatch" // provider_mismatch — tainted success
	| "hard_failure" // failed / timeout with no protocol cause
	| "protocol_failure"; // tool / MCP-protocol failure — heaviest penalty

/**
 * Penalty weights applied when folding an outcome into the Beta posterior.
 * Each outcome contributes `weight * alphaShare` to alpha (successes) and
 * `weight * betaShare` to beta (failures). AC-3 ordering invariant:
 *   protocol_failure penalizes more than hard_failure,
 *   hard_failure more than rework,
 *   rework more than a clean success (which has zero beta share).
 */
export const OUTCOME_SHARES: Record<RunOutcome, { alpha: number; beta: number }> = {
	success: { alpha: 1.0, beta: 0.0 },
	rework: { alpha: 0.5, beta: 0.5 },
	mismatch: { alpha: 0.3, beta: 0.7 },
	hard_failure: { alpha: 0.0, beta: 1.0 },
	protocol_failure: { alpha: 0.0, beta: 1.5 },
};

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/**
 * Per-day exponential decay multiplier for an observation `ageDays` old.
 * lambda in (0,1]; lambda=0.97 ≈ 22-day half-life. Clamps negative ages to 0.
 */
export function decayWeight(ageDays: number, lambda = 0.97): number {
	if (lambda <= 0 || lambda > 1) throw new RangeError("lambda must be in (0,1]");
	return Math.pow(lambda, Math.max(0, ageDays));
}

// ---------------------------------------------------------------------------
// Beta-Bernoulli posterior (AC-5)
// ---------------------------------------------------------------------------

export interface BetaPosterior {
	/** Beta alpha parameter (prior 1 + decayed success mass). */
	alpha: number;
	/** Beta beta parameter (prior 1 + decayed failure mass). */
	beta: number;
}

export interface ReliabilityObservation {
	outcome: RunOutcome;
	/** Age of the observation in days (drives decay). */
	ageDays: number;
}

/**
 * Fold a set of observations into a Beta(alpha, beta) posterior with a uniform
 * Beta(1,1) prior. This is the P1070 Beta-Bernoulli posterior; we do not
 * re-derive it — alpha accumulates (decayed) success mass, beta accumulates
 * (decayed, class-weighted) failure mass.
 */
export function computePosterior(
	observations: ReliabilityObservation[],
	lambda = 0.97,
	prior: BetaPosterior = { alpha: 1, beta: 1 },
): BetaPosterior {
	let alpha = prior.alpha;
	let beta = prior.beta;
	for (const obs of observations) {
		const w = decayWeight(obs.ageDays, lambda);
		const share = OUTCOME_SHARES[obs.outcome];
		alpha += w * share.alpha;
		beta += w * share.beta;
	}
	return { alpha, beta };
}

/** Posterior mean = alpha / (alpha + beta). The point reliability score [0,1]. */
export function posteriorMean(p: BetaPosterior): number {
	return p.alpha / (p.alpha + p.beta);
}

/** Sum of decay weights = the effective (decayed) sample count. */
export function effectiveSampleCount(observations: ReliabilityObservation[], lambda = 0.97): number {
	return observations.reduce((acc, o) => acc + decayWeight(o.ageDays, lambda), 0);
}

// ---------------------------------------------------------------------------
// Confidence tiering (AC-2)
// ---------------------------------------------------------------------------

export type Confidence = "low" | "medium" | "high";

/** Map an effective sample count to a confidence tier (mirrors the SQL view). */
export function confidenceFor(effSampleCount: number): Confidence {
	if (effSampleCount < 5) return "low";
	if (effSampleCount < 20) return "medium";
	return "high";
}

// ---------------------------------------------------------------------------
// Cold-start hierarchical fallback (AC-2)
// ---------------------------------------------------------------------------

export interface ReliabilityCellLike {
	score: number;
	effectiveSampleCount: number;
	sampleCount: number;
}

/**
 * Resolve a reliability estimate using the hierarchical fallback chain:
 *   exact task_class → task_family aggregate → scope _global → tier prior.
 * The first level with effectiveSampleCount >= minSamples wins; otherwise we
 * fall through, and if nothing qualifies we return the tier/capability prior
 * with zero confidence.
 */
export function resolveColdStart(
	chain: {
		exact?: ReliabilityCellLike | null;
		family?: ReliabilityCellLike | null;
		global?: ReliabilityCellLike | null;
	},
	tierPrior: number,
	minSamples = 5,
): { score: number; confidence: Confidence; level: "exact" | "family" | "global" | "prior" } {
	const levels: Array<["exact" | "family" | "global", ReliabilityCellLike | null | undefined]> = [
		["exact", chain.exact],
		["family", chain.family],
		["global", chain.global],
	];
	for (const [level, cell] of levels) {
		if (cell && cell.effectiveSampleCount >= minSamples) {
			return { score: cell.score, confidence: confidenceFor(cell.effectiveSampleCount), level };
		}
	}
	// Nothing met the bar — blend the strongest available signal toward the
	// prior, or fall back to the bare prior if no data at all.
	const best = chain.exact ?? chain.family ?? chain.global ?? null;
	if (best && best.effectiveSampleCount > 0) {
		// shrink toward prior proportional to how far below minSamples we are
		const wData = Math.min(1, best.effectiveSampleCount / minSamples);
		const blended = wData * best.score + (1 - wData) * tierPrior;
		return { score: blended, confidence: "low", level: "prior" };
	}
	return { score: tierPrior, confidence: "low", level: "prior" };
}
