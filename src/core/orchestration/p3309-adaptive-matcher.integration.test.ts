/**
 * P3309 (umbrella) integration tests — AC-2, AC-3, AC-4.
 *
 * These prove the COMPOSITION of the four merged children end-to-end:
 *   - P3310 assessDifficulty() produces difficulty + canonical task_class.
 *   - P3312 matchWorkToRoute() consumes that signal and a reliability source.
 *   - P3311 reliability is injected as cells (success_rate, sample_count); the
 *     matcher applies its reliability floor + AC-7 cold-start + AC-9 downshift
 *     lock. No live DB — reliability is dependency-injected, exactly the seam
 *     computeShadowLog wires to the real ledger in production.
 *
 * Hermetic + pure: no DB, no config, no pollution. Run with vitest.
 */

import { describe, it, expect } from "vitest";
import { assessDifficulty } from "./difficulty-assessor.ts";
import {
	matchWorkToRoute,
	MIN_RELIABILITY_SAMPLES,
	type ReliabilityCell,
	type RouteCandidate,
	type WorkItem,
} from "./match-work-to-route.ts";

// A realistic candidate pool: a cheap free-tier route and a costly frontier route.
const CHEAP = (): RouteCandidate => ({
	route_id: 1,
	model_name: "haiku-cheap",
	route_provider: "anthropic",
	tier: "free",
	cost_per_million_input: 0.25,
	priority: 1,
});
const MID = (): RouteCandidate => ({
	route_id: 2,
	model_name: "sonnet-mid",
	route_provider: "anthropic",
	tier: "mid",
	cost_per_million_input: 3,
	priority: 1,
});
const FRONTIER = (): RouteCandidate => ({
	route_id: 3,
	model_name: "opus-frontier",
	route_provider: "anthropic",
	tier: "frontier",
	cost_per_million_input: 15,
	priority: 1,
});

/** Reliability injector keyed by route_id → cell. */
function relByRoute(
	map: Record<number, ReliabilityCell>,
	fallback: ReliabilityCell = { sample_count: 0, success_rate: 0 },
) {
	return async (
		routeId: number,
		_taskClass: string,
		_tier: string,
	): Promise<ReliabilityCell> => map[routeId] ?? fallback;
}

// ---------------------------------------------------------------------------
// AC-2: mechanical + low difficulty → cheapest capable route (not frontier)
// ---------------------------------------------------------------------------

describe("P3309 AC-2: mechanical low-difficulty routes to cheapest capable", () => {
	it("a mechanical task with low difficulty picks the cheap route, not frontier", async () => {
		// P3310: a 'reaper/janitor/mechanical' role → task_class='mechanical',
		// trivial difficulty (no ACs, no blast-radius keywords, no rework).
		const signal = assessDifficulty({ role: "mechanical-reaper" });
		expect(signal.taskClass).toBe("mechanical");
		expect(signal.difficultyScore).toBeLessThan(0.2); // free band

		const item: WorkItem = {
			difficulty: signal.difficultyScore,
			task_class: signal.taskClass,
		};

		// All routes have ample reliability; the floor for low difficulty is 0.30.
		const result = await matchWorkToRoute(item, [FRONTIER(), MID(), CHEAP()], {
			fetchReliability: relByRoute({
				1: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.6 },
				2: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.9 },
				3: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.99 },
			}),
		});

		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		// Cheapest capable route wins — NOT the frontier model.
		expect(result.candidates[0].route_id).toBe(1);
		expect(result.candidates[0].model_name).toBe("haiku-cheap");
		expect(result.candidates[0].route_provider).not.toBe(undefined);
		// frontier must not be the top pick
		expect(result.candidates[0].tier).toBe("free");
	});
});

// ---------------------------------------------------------------------------
// AC-3: high difficulty + cheap-model-reliability-below-floor → matcher picks
//       the capable (frontier) route that clears the floor, NOT the cheapest.
// ---------------------------------------------------------------------------

describe("P3309 AC-3: high difficulty below-floor cheap → costlier capable route", () => {
	it("routes to frontier when the cheap model is below the reliability floor", async () => {
		// P3310: an architecture/schema/migration task → high difficulty.
		const signal = assessDifficulty({
			role: "developer",
			task: "schema migration refactor of the workflow state machine",
			acCount: 12,
			reworkCount: 1, // prior rework escalates into the frontier band
		});
		expect(signal.difficultyScore).toBeGreaterThanOrEqual(0.8); // frontier band
		// task_class here is code_dev (NOT downshift-locked) → downshift is allowed,
		// but the cheap route is below EVERY tier floor so it can never be chosen.

		const item: WorkItem = {
			difficulty: signal.difficultyScore,
			task_class: signal.taskClass,
		};

		// Floor for difficulty>=0.8 is 0.85. Cheap route is far below; frontier clears.
		const result = await matchWorkToRoute(item, [CHEAP(), FRONTIER()], {
			fetchReliability: relByRoute({
				1: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.2 }, // below floor
				3: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.95 }, // clears 0.85
			}),
		});

		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		// The capable frontier route is selected despite being far costlier.
		expect(result.candidates[0].route_id).toBe(3);
		expect(result.candidates[0].tier).toBe("frontier");
		// The cheap below-floor route must NOT appear in the eligible set.
		expect(result.candidates.some((c) => c.route_id === 1)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC-4: Haiku-regression — (model, task_class) reliability below floor →
//       NEVER selected for that class regardless of cost.
// ---------------------------------------------------------------------------

describe("P3309 AC-4: Haiku-regression — below-floor model never selected for class", () => {
	it("excludes the cheap model for a locked task_class even though it is cheapest", async () => {
		// gate_review is a DOWNSHIFT_LOCKED task_class: no downshift can rescue a
		// below-floor candidate. The cheap (Haiku) route is below the 0.85 floor.
		const signal = assessDifficulty({ role: "gate-reviewer" });
		expect(signal.taskClass).toBe("gate_review");

		// Force high difficulty so the floor is strict (0.85).
		const item: WorkItem = {
			difficulty: 0.9,
			task_class: signal.taskClass,
		};

		const result = await matchWorkToRoute(item, [CHEAP(), FRONTIER()], {
			fetchReliability: relByRoute({
				1: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.4 }, // Haiku below floor
				3: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.3 }, // frontier ALSO below floor
			}),
		});

		// Both below floor AND task_class is locked → no downshift → no eligible route.
		expect(result.kind).toBe("no_eligible_route");
		if (result.kind !== "no_eligible_route") return;
		expect(result.missing_axis).toBe("reliability");
	});

	it("when a capable route clears the floor, the below-floor cheap model is still excluded", async () => {
		const item: WorkItem = {
			difficulty: 0.9,
			task_class: "gate_review",
		};

		const result = await matchWorkToRoute(item, [CHEAP(), FRONTIER()], {
			fetchReliability: relByRoute({
				1: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.4 }, // below floor
				3: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.92 }, // clears floor
			}),
		});

		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		// Despite being cheapest, the below-floor Haiku route is excluded entirely.
		expect(result.candidates.some((c) => c.route_id === 1)).toBe(false);
		expect(result.candidates[0].route_id).toBe(3);
	});

	it("the same below-floor model CAN serve an unlocked low-difficulty class (downshift only where permitted)", async () => {
		// AC-4 clause: "it downshifts only where the task_class permits."
		// For a mechanical (unlocked) low-difficulty item, a 0.4-reliability cheap
		// route clears the low floor (0.30) and is selected.
		const item: WorkItem = {
			difficulty: 0.1,
			task_class: "mechanical",
		};
		const result = await matchWorkToRoute(item, [CHEAP()], {
			fetchReliability: relByRoute({
				1: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.4 },
			}),
		});
		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		expect(result.candidates[0].route_id).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC-1 / AC-5: single matcher composes all child outputs (signal + reliability).
// ---------------------------------------------------------------------------

describe("P3309 AC-1/AC-5: single matcher composes child outputs", () => {
	it("difficulty (P3310) + reliability (P3311) flow through one matchWorkToRoute call", async () => {
		const signal = assessDifficulty({ role: "developer", acCount: 6 });
		const item: WorkItem = {
			difficulty: signal.difficultyScore,
			task_class: signal.taskClass,
		};
		const result = await matchWorkToRoute(item, [MID()], {
			fetchReliability: relByRoute({
				2: { sample_count: MIN_RELIABILITY_SAMPLES, success_rate: 0.8 },
			}),
		});
		expect(result.kind).toBe("ranked");
		if (result.kind !== "ranked") return;
		const c = result.candidates[0];
		// All four axes present (AC-1) and composed from the children's outputs.
		expect(c.scores).toHaveProperty("difficulty_fit");
		expect(c.scores).toHaveProperty("capability");
		expect(c.scores).toHaveProperty("reliability");
		expect(c.scores).toHaveProperty("cost_quota");
		expect(c.scores.reliability).toBe(0.8);
	});
});
