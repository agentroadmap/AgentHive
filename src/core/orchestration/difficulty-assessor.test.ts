/**
 * P3310 AC-2 tests: deterministic difficulty assessor (no LLM).
 * Covers: trivial single-AC → low tier; 12-AC high-blast-radius architecture
 * item → high tier; rework_count escalation raises the tier; AC-3 overrides.
 */

import { describe, it, expect } from "vitest";
import {
	assessDifficulty,
	classifyTaskClass,
	scoreToTier,
	capabilityTierRank,
	TASK_CLASS,
	TASK_CLASS_VALUES,
	isTaskClass,
	CAPABILITY_TIER_LADDER,
} from "./difficulty-assessor.ts";
import { getTierRank } from "./resolvers/tier-aware-resolver.ts";

describe("assessDifficulty — AC-2 deterministic heuristic", () => {
	it("trivial single-AC code item → low tier (free/lower)", () => {
		const r = assessDifficulty({
			role: "developer",
			task: "fix a typo in the README",
			acCount: 1,
			reworkCount: 0,
		});
		expect(r.difficultyScore).toBeLessThan(0.2);
		expect(r.requiredCapabilityTier).toBe("free");
		expect(r.taskClass).toBe(TASK_CLASS.CODE_DEV);
	});

	it("12-AC high-blast-radius architecture item → high tier (frontier)", () => {
		const r = assessDifficulty({
			role: "architect",
			task: "redesign the workflow state machine: schema migration, breaking protocol refactor",
			acCount: 12,
			reworkCount: 0,
		});
		expect(r.difficultyScore).toBeGreaterThanOrEqual(0.75);
		expect(r.requiredCapabilityTier).toBe("frontier");
	});

	it("rework_count escalation raises the tier", () => {
		const base = assessDifficulty({
			role: "developer",
			task: "implement the feature",
			acCount: 4,
			reworkCount: 0,
		});
		const reworked = assessDifficulty({
			role: "developer",
			task: "implement the feature",
			acCount: 4,
			reworkCount: 2,
		});
		expect(reworked.difficultyScore).toBeGreaterThan(base.difficultyScore);
		expect(capabilityTierRank(reworked.requiredCapabilityTier)).toBeGreaterThan(
			capabilityTierRank(base.requiredCapabilityTier),
		);
	});

	it("is a pure deterministic function (same input → same output)", () => {
		const input = { role: "developer", task: "do a thing", acCount: 5, reworkCount: 1 };
		expect(assessDifficulty(input)).toEqual(assessDifficulty(input));
	});

	it("difficulty_score always lands in [0,1] even for extreme inputs", () => {
		const huge = assessDifficulty({
			role: "architect",
			task: "architecture migration schema refactor breaking protocol workflow security auth",
			acCount: 999,
			reworkCount: 999,
		});
		expect(huge.difficultyScore).toBeLessThanOrEqual(1);
		expect(huge.difficultyScore).toBeGreaterThanOrEqual(0);
		const neg = assessDifficulty({ role: "developer", acCount: -5, reworkCount: -5 });
		expect(neg.difficultyScore).toBeGreaterThanOrEqual(0);
	});
});

describe("AC-3 task_class enum + overrides", () => {
	it("classifies roles into the task_class enum", () => {
		expect(classifyTaskClass("gate-reviewer")).toBe(TASK_CLASS.GATE_REVIEW);
		expect(classifyTaskClass("skeptic-alpha")).toBe(TASK_CLASS.GATE_REVIEW);
		expect(classifyTaskClass("researcher")).toBe(TASK_CLASS.RESEARCH);
		expect(classifyTaskClass("developer")).toBe(TASK_CLASS.CODE_DEV);
		expect(classifyTaskClass("mcp-protocol")).toBe(TASK_CLASS.MCP_PROTOCOL);
		expect(classifyTaskClass("triage")).toBe(TASK_CLASS.TRIAGE);
	});

	it("honors an explicit task_class override over the heuristic", () => {
		const r = assessDifficulty({
			role: "developer",
			task: "anything",
			acCount: 1,
			taskClassOverride: TASK_CLASS.MECHANICAL,
		});
		expect(r.taskClass).toBe(TASK_CLASS.MECHANICAL);
		expect(r.overridden).toBe(true);
	});

	it("honors an explicit tier override over the heuristic", () => {
		const r = assessDifficulty({
			role: "developer",
			task: "fix a typo",
			acCount: 1,
			tierOverride: "frontier",
		});
		expect(r.requiredCapabilityTier).toBe("frontier");
		expect(r.overridden).toBe(true);
	});

	it("TASK_CLASS_VALUES matches the squad_dispatch CHECK constraint set", () => {
		expect([...TASK_CLASS_VALUES].sort()).toEqual(
			["code_dev", "gate_review", "mcp_protocol", "mechanical", "research", "triage"].sort(),
		);
		expect(isTaskClass("code_dev")).toBe(true);
		expect(isTaskClass("nonsense")).toBe(false);
	});
});

describe("AC-4 tier vocabulary reuse (P1005/P1091)", () => {
	it("capabilityTierRank delegates to the canonical getTierRank", () => {
		for (const t of CAPABILITY_TIER_LADDER) {
			expect(capabilityTierRank(t)).toBe(getTierRank(t));
		}
	});

	it("scoreToTier is monotonic across the ladder", () => {
		expect(getTierRank(scoreToTier(0.0))).toBeLessThan(getTierRank(scoreToTier(0.3)));
		expect(getTierRank(scoreToTier(0.3))).toBeLessThan(getTierRank(scoreToTier(0.6)));
		expect(getTierRank(scoreToTier(0.6))).toBeLessThan(getTierRank(scoreToTier(0.9)));
	});
});
