/**
 * P3310 AC-2: unit tests for the difficulty assessor.
 *
 * Required scenarios:
 *   (a) trivial single-AC item → low tier
 *   (b) 12-AC architecture item with complex text → high tier (frontier)
 *   (c) rework_count escalation raises tier
 */

import { describe, it, expect } from "vitest";
import {
	assessDifficulty,
	resolveTaskClass,
	scoreToTier,
	type DifficultyInput,
} from "./difficulty-assessor.ts";

describe("resolveTaskClass", () => {
	it("maps gate roles to gate_review", () => {
		expect(resolveTaskClass("gate-reviewer")).toBe("gate_review");
		expect(resolveTaskClass("skeptic-alpha")).toBe("gate_review");
		expect(resolveTaskClass("gate_decision_agent")).toBe("gate_review");
		expect(resolveTaskClass("merge_decision_agent")).toBe("gate_review");
		expect(resolveTaskClass("reviewer-d1")).toBe("gate_review");
		expect(resolveTaskClass("code-reviewer")).toBe("gate_review");
	});

	it("maps dev roles to code_dev", () => {
		expect(resolveTaskClass("developer")).toBe("code_dev");
		expect(resolveTaskClass("architect")).toBe("code_dev");
		expect(resolveTaskClass("engineer")).toBe("code_dev");
		expect(resolveTaskClass("integration")).toBe("code_dev");
		expect(resolveTaskClass("qa")).toBe("code_dev");
	});

	it("maps research roles to research", () => {
		expect(resolveTaskClass("researcher")).toBe("research");
		expect(resolveTaskClass("enhancer")).toBe("research");
		expect(resolveTaskClass("drafter")).toBe("research");
	});

	it("defaults unknown roles to mechanical", () => {
		expect(resolveTaskClass("unknown_role")).toBe("mechanical");
	});

	it("honours explicit task_class override", () => {
		expect(resolveTaskClass("developer", "mcp_protocol")).toBe("mcp_protocol");
		expect(resolveTaskClass("reviewer", "triage")).toBe("triage");
	});

	it("ignores invalid task_class override", () => {
		expect(resolveTaskClass("developer", "bogus")).toBe("code_dev");
	});
});

describe("scoreToTier", () => {
	it("maps score < 0.25 to lower", () => {
		expect(scoreToTier(0)).toBe("lower");
		expect(scoreToTier(0.20)).toBe("lower");
		expect(scoreToTier(0.249)).toBe("lower");
	});

	it("maps score 0.25–0.499 to mid", () => {
		expect(scoreToTier(0.25)).toBe("mid");
		expect(scoreToTier(0.35)).toBe("mid");
		expect(scoreToTier(0.499)).toBe("mid");
	});

	it("maps score >= 0.50 to frontier", () => {
		expect(scoreToTier(0.50)).toBe("frontier");
		expect(scoreToTier(0.75)).toBe("frontier");
		expect(scoreToTier(1.0)).toBe("frontier");
	});
});

describe("assessDifficulty — AC-2 scenarios", () => {
	it("(a) trivial single-AC mechanical item → lower tier", () => {
		const input: DifficultyInput = {
			role: "mechanical",
			acCount: 1,
			acAvgWords: 10,
			reworkCount: 0,
		};
		const result = assessDifficulty(input);
		// score = 0.05 (mechanical base) + 0 (≤3 ACs) + 0 (short text) + 0 (no rework) = 0.05
		expect(result.difficulty_score).toBeCloseTo(0.05, 3);
		expect(result.required_capability_tier).toBe("lower");
		expect(result.task_class).toBe("mechanical");
	});

	it("(b) 12-AC architecture item with complex text → frontier tier", () => {
		const input: DifficultyInput = {
			role: "architect",
			acCount: 12,
			acAvgWords: 50, // > 40 words per criterion
			reworkCount: 0,
		};
		const result = assessDifficulty(input);
		// score = 0.25 (code_dev) + 0.30 (12 ACs) + 0.10 (avg > 40 words) = 0.65
		expect(result.difficulty_score).toBeCloseTo(0.65, 3);
		expect(result.required_capability_tier).toBe("frontier");
		expect(result.task_class).toBe("code_dev");
	});

	it("(c) rework_count escalation raises tier from mid to frontier", () => {
		const base: DifficultyInput = {
			role: "developer",
			acCount: 5,   // 4–7 → +0.10
			acAvgWords: 20,
			reworkCount: 0,
		};
		const baseResult = assessDifficulty(base);
		// score = 0.25 (code_dev) + 0.10 (4–7 ACs) = 0.35 → mid
		expect(baseResult.required_capability_tier).toBe("mid");

		const reworked: DifficultyInput = { ...base, reworkCount: 3 };
		const reworkResult = assessDifficulty(reworked);
		// score = 0.25 + 0.10 + 0.30 (3 reworks × 0.10) = 0.65 → frontier
		expect(reworkResult.difficulty_score).toBeCloseTo(0.65, 3);
		expect(reworkResult.required_capability_tier).toBe("frontier");
	});

	it("rework escalation is capped at 0.30 (3 reworks max)", () => {
		const input: DifficultyInput = {
			role: "developer",
			acCount: 1,
			acAvgWords: 5,
			reworkCount: 10, // far above cap
		};
		const result = assessDifficulty(input);
		// score = 0.25 + 0 + 0 + 0.30 (capped) = 0.55
		expect(result.difficulty_score).toBeCloseTo(0.55, 3);
		expect(result.required_capability_tier).toBe("frontier");
	});

	it("explicit tier_override beats computed tier", () => {
		const input: DifficultyInput = {
			role: "developer",
			acCount: 1,
			acAvgWords: 5,
			reworkCount: 0,
			tierOverride: "free",
		};
		const result = assessDifficulty(input);
		expect(result.required_capability_tier).toBe("free");
	});

	it("invalid tier_override is ignored and computed tier is used", () => {
		const input: DifficultyInput = {
			role: "developer",
			acCount: 1,
			acAvgWords: 5,
			reworkCount: 0,
			tierOverride: "ultra", // not a valid tier
		};
		const result = assessDifficulty(input);
		// score = 0.25 → mid
		expect(result.required_capability_tier).toBe("mid");
	});

	it("score is clamped to [0, 1]", () => {
		const input: DifficultyInput = {
			role: "mcp_protocol",
			acCount: 20,
			acAvgWords: 100,
			reworkCount: 10,
			taskClassOverride: "mcp_protocol",
		};
		const result = assessDifficulty(input);
		expect(result.difficulty_score).toBeLessThanOrEqual(1);
		expect(result.difficulty_score).toBeGreaterThanOrEqual(0);
	});
});
