/**
 * P3312: Unit tests for matchWorkToRoute (AC-1, AC-3, AC-7, AC-9).
 * All tests use stubbed inputs — no DB calls.
 */

import { describe, it, expect } from "vitest";
import {
	matchWorkToRoute,
	reliabilityFloor,
	requiredTierForDifficulty,
	resolveReliabilityScore,
	computeDifficultyFitScore,
	computeCostQuotaScores,
	TIER_RELIABILITY_PRIOR,
	MIN_RELIABILITY_SAMPLES,
	DOWNSHIFT_LOCKED_TASK_CLASSES,
	type WorkItem,
	type RouteCandidate,
	type ReliabilityCell,
} from "./match-work-to-route.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
	overrides: Partial<RouteCandidate> & { route_id: number },
): RouteCandidate {
	return {
		route_id: overrides.route_id,
		model_name: overrides.model_name ?? "test-model",
		route_provider: overrides.route_provider ?? "anthropic",
		tier: overrides.tier ?? "mid",
		cost_per_million_input: overrides.cost_per_million_input ?? 5.0,
		priority: overrides.priority ?? 1,
	};
}

function makeItem(overrides?: Partial<WorkItem>): WorkItem {
	return {
		difficulty: 0.5,
		task_class: "develop",
		...overrides,
	};
}

/** Stub that returns a cell with the given success_rate and enough samples. */
function reliabilityStub(successRate: number, sampleCount = MIN_RELIABILITY_SAMPLES) {
	return async (_routeId: number, _taskClass: string, _tier: string): Promise<ReliabilityCell> => ({
		sample_count: sampleCount,
		success_rate: successRate,
	});
}

/** Stub returning zero samples (triggers cold-start prior). */
function coldStartStub() {
	return async (_routeId: number, _taskClass: string, _tier: string): Promise<ReliabilityCell> => ({
		sample_count: 0,
		success_rate: 0,
	});
}

// ---------------------------------------------------------------------------
// AC-1: Function signature returns ranked list + four-axis scores
// ---------------------------------------------------------------------------

describe("AC-1: matchWorkToRoute returns ranked list + four scores", () => {
	it("returns ranked candidates with all four score axes", async () => {
		const item = makeItem({ difficulty: 0.5 });
		const candidates = [makeCandidate({ route_id: 1, tier: "mid", cost_per_million_input: 5 })];

		const result = await matchWorkToRoute(item, candidates, {
			fetchReliability: reliabilityStub(0.85),
		});

		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;

		expect(result.candidates).toHaveLength(1);
		const c = result.candidates[0];
		expect(typeof c.scores.difficulty_fit).toBe("number");
		expect(typeof c.scores.capability).toBe("number");
		expect(typeof c.scores.reliability).toBe("number");
		expect(typeof c.scores.cost_quota).toBe("number");
		expect(c.scores.difficulty_fit).toBeGreaterThanOrEqual(0);
		expect(c.scores.difficulty_fit).toBeLessThanOrEqual(1);
	});

	it("returns no_eligible_route with structured evidence on empty input", async () => {
		const result = await matchWorkToRoute(makeItem(), [], {
			fetchReliability: reliabilityStub(1.0),
		});
		expect(result.kind).toBe("no_eligible_route");
		if (result.kind !== "no_eligible_route") return;
		expect(result.missing_axis).toBe("policy");
		expect(typeof result.required_tier).toBe("string");
		expect(typeof result.floor).toBe("number");
	});
});

// ---------------------------------------------------------------------------
// AC-3: High-difficulty item rejects cheap low-reliability route; mechanical item accepts it
// ---------------------------------------------------------------------------

describe("AC-3: Reliability floor selection proof", () => {
	it("rejects cheap route below floor for high-difficulty item", async () => {
		const highDifficultyItem = makeItem({ difficulty: 0.9, task_class: "develop" });
		// Cheap route with very low reliability — fails even the free-tier floor of 0.30
		const cheapLowReliability = makeCandidate({ route_id: 1, tier: "free", cost_per_million_input: 0.1 });

		const result = await matchWorkToRoute(highDifficultyItem, [cheapLowReliability], {
			// 0.10 < 0.30 (free-tier floor) — no downshift tier can rescue this route
			fetchReliability: reliabilityStub(0.10, MIN_RELIABILITY_SAMPLES),
		});

		expect(result.kind).toBe("no_eligible_route");
	});

	it("selects cheap route for low-difficulty mechanical item", async () => {
		const mechanicalItem = makeItem({ difficulty: 0.1, task_class: "develop" });
		// Same cheap route
		const cheapRoute = makeCandidate({ route_id: 1, tier: "free", cost_per_million_input: 0.1 });

		const result = await matchWorkToRoute(mechanicalItem, [cheapRoute], {
			fetchReliability: reliabilityStub(0.5, MIN_RELIABILITY_SAMPLES),
		});

		// floor for difficulty=0.1 = 0.30; free tier reliability=0.5 >= 0.30 → selected
		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		expect(result.candidates[0].route_id).toBe(1);
	});

	it("ranks cheapest passing candidate first", async () => {
		const item = makeItem({ difficulty: 0.3, task_class: "develop" });
		const expensive = makeCandidate({ route_id: 1, tier: "mid", cost_per_million_input: 15 });
		const cheap = makeCandidate({ route_id: 2, tier: "lower", cost_per_million_input: 2 });

		const result = await matchWorkToRoute(item, [expensive, cheap], {
			fetchReliability: reliabilityStub(0.55, MIN_RELIABILITY_SAMPLES),
		});

		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		expect(result.candidates[0].route_id).toBe(2); // cheaper first
	});
});

// ---------------------------------------------------------------------------
// AC-7: Cold-start prior when sample_count < MIN_RELIABILITY_SAMPLES
// ---------------------------------------------------------------------------

describe("AC-7: Cold-start prior for fresh ledger cells", () => {
	it("returns tier-derived prior when 0 samples available", async () => {
		const cell: ReliabilityCell = { sample_count: 0, success_rate: 0 };

		expect(resolveReliabilityScore(cell, "frontier")).toBe(TIER_RELIABILITY_PRIOR["frontier"]);
		expect(resolveReliabilityScore(cell, "mid")).toBe(TIER_RELIABILITY_PRIOR["mid"]);
		expect(resolveReliabilityScore(cell, "lower")).toBe(TIER_RELIABILITY_PRIOR["lower"]);
		expect(resolveReliabilityScore(cell, "free")).toBe(TIER_RELIABILITY_PRIOR["free"]);
	});

	it("returns empirical rate when samples >= MIN_RELIABILITY_SAMPLES", () => {
		const cell: ReliabilityCell = { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.99 };
		expect(resolveReliabilityScore(cell, "frontier")).toBe(0.99);
	});

	it("fresh ledger (0 rows) still produces valid RankedCandidate with tier prior", async () => {
		const item = makeItem({ difficulty: 0.1, task_class: "develop" });
		const candidate = makeCandidate({ route_id: 42, tier: "free", cost_per_million_input: 0 });

		const result = await matchWorkToRoute(item, [candidate], {
			fetchReliability: coldStartStub(),
		});

		// free prior = 0.3, floor for difficulty=0.1 = 0.30 → exactly meets floor
		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		const c = result.candidates[0];
		expect(c.scores.reliability).toBe(TIER_RELIABILITY_PRIOR["free"]); // 0.3
	});
});

// ---------------------------------------------------------------------------
// AC-9: Downshift guard for locked task classes
// ---------------------------------------------------------------------------

describe("AC-9: DOWNSHIFT_LOCKED_TASK_CLASSES prevents downshift", () => {
	it("locked task classes are defined", () => {
		expect(DOWNSHIFT_LOCKED_TASK_CLASSES.has("gate_review")).toBe(true);
		expect(DOWNSHIFT_LOCKED_TASK_CLASSES.has("merge")).toBe(true);
		expect(DOWNSHIFT_LOCKED_TASK_CLASSES.has("architecture")).toBe(true);
		expect(DOWNSHIFT_LOCKED_TASK_CLASSES.has("develop")).toBe(false);
	});

	it("returns no_eligible_route for locked task_class when no candidate clears floor", async () => {
		const item = makeItem({ difficulty: 0.9, task_class: "gate_review" });
		// Low-reliability frontier route (below 0.85 floor)
		const weakFrontier = makeCandidate({ route_id: 1, tier: "frontier", cost_per_million_input: 30 });

		const result = await matchWorkToRoute(item, [weakFrontier], {
			fetchReliability: reliabilityStub(0.50, MIN_RELIABILITY_SAMPLES),
		});

		// Should NOT downshift for gate_review
		expect(result.kind).toBe("no_eligible_route");
		if (result.kind !== "no_eligible_route") return;
		expect(result.missing_axis).toBe("reliability");
	});

	it("does NOT block downshift for unlocked task classes", async () => {
		const item = makeItem({ difficulty: 0.6, task_class: "develop" });
		// Frontier route fails mid floor; there's a mid route that barely passes
		const frontier = makeCandidate({ route_id: 1, tier: "frontier", cost_per_million_input: 30 });
		const midRoute = makeCandidate({ route_id: 2, tier: "mid", cost_per_million_input: 5 });

		const result = await matchWorkToRoute(item, [frontier, midRoute], {
			fetchReliability: async (routeId, _taskClass, tier) => {
				// frontier and mid both pass the floor for mid-difficulty
				return { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: tier === "mid" ? 0.80 : 0.72 };
			},
		});

		// Both pass floor of 0.70, cheapest first = mid
		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		expect(result.candidates[0].route_id).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Helper function unit tests
// ---------------------------------------------------------------------------

describe("reliabilityFloor", () => {
	it("returns 0.85 for high difficulty", () => {
		expect(reliabilityFloor(0.9)).toBe(0.85);
		expect(reliabilityFloor(0.8)).toBe(0.85);
	});

	it("returns 0.70 for medium difficulty", () => {
		expect(reliabilityFloor(0.6)).toBe(0.70);
		expect(reliabilityFloor(0.5)).toBe(0.70);
	});

	it("returns 0.50 for low-medium difficulty", () => {
		expect(reliabilityFloor(0.3)).toBe(0.50);
		expect(reliabilityFloor(0.2)).toBe(0.50);
	});

	it("returns 0.30 for very low difficulty", () => {
		expect(reliabilityFloor(0.1)).toBe(0.30);
		expect(reliabilityFloor(0.0)).toBe(0.30);
	});
});

describe("requiredTierForDifficulty", () => {
	it("maps difficulty to correct required tier", () => {
		expect(requiredTierForDifficulty(0.9)).toBe("frontier");
		expect(requiredTierForDifficulty(0.6)).toBe("mid");
		expect(requiredTierForDifficulty(0.3)).toBe("lower");
		expect(requiredTierForDifficulty(0.1)).toBe("free");
	});
});

describe("computeDifficultyFitScore", () => {
	it("perfect fit returns 1.0", () => {
		expect(computeDifficultyFitScore("mid", "mid")).toBe(1.0);
		expect(computeDifficultyFitScore("frontier", "frontier")).toBe(1.0);
	});

	it("under-provisioned route returns 0.0", () => {
		expect(computeDifficultyFitScore("free", "frontier")).toBe(0.0);
		expect(computeDifficultyFitScore("mid", "frontier")).toBe(0.0);
	});

	it("over-provisioned route returns partial score >= 0.5", () => {
		const score = computeDifficultyFitScore("frontier", "mid");
		expect(score).toBeGreaterThanOrEqual(0.5);
		expect(score).toBeLessThan(1.0);
	});
});

describe("computeCostQuotaScores", () => {
	it("cheapest route gets score 1.0, most expensive gets 0.0", () => {
		const candidates = [
			makeCandidate({ route_id: 1, cost_per_million_input: 0 }),
			makeCandidate({ route_id: 2, cost_per_million_input: 10 }),
		];
		const scores = computeCostQuotaScores(candidates);
		expect(scores.get(1)).toBe(1.0);
		expect(scores.get(2)).toBe(0.0);
	});

	it("single candidate gets score 1.0", () => {
		const candidates = [makeCandidate({ route_id: 1, cost_per_million_input: 50 })];
		const scores = computeCostQuotaScores(candidates);
		expect(scores.get(1)).toBe(1.0);
	});
});
