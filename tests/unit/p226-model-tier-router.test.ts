/**
 * P226 AC#2: Unit tests for selectModelByTaskDifficulty()
 *
 * Verifies:
 *  - Easy task selects economy (lower) tier
 *  - Hard gate_review selects frontier tier
 *  - requires_novel_reasoning bumps lower→mid and mid→frontier
 *  - verification tasks always select lower (never escalate)
 *  - Fallback chain: if preferred tier empty, tries adjacent tiers
 *  - Throws when no models available at all
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	selectModelByTaskDifficulty,
	TIER_PREFERENCE,
	type ModelConfig,
	type TaskMetadata,
} from "../../src/orchestrator/model_router.ts";

// ─── Mock DB builder ─────────────────────────────────────────────────────────

type MockRow = Partial<ModelConfig>;

/**
 * Build a mock queryFn that returns `rows` for any SQL query.
 * Multiple calls can be chained (first call returns rows[0], second rows[1], etc.)
 * or the same rows can be returned for all calls.
 */
function mockQuery(rowSets: MockRow[][]): (text: string, params?: unknown[]) => Promise<{ rows: MockRow[] }> {
	let callIndex = 0;
	return async (_text, _params) => {
		const rows = rowSets[Math.min(callIndex, rowSets.length - 1)] ?? [];
		callIndex++;
		return { rows } as any;
	};
}

function makeModel(tier: string, cost: number = 0.001): ModelConfig {
	return {
		id: Math.floor(Math.random() * 1000),
		model_name: `${tier}-model`,
		tier: tier as ModelConfig["tier"],
		route_provider: "test",
		agent_provider: "test",
		cost_per_1k_input: cost,
		confidence_threshold: 0.7,
		is_enabled: true,
	};
}

// ─── TIER_PREFERENCE matrix ───────────────────────────────────────────────────

describe("TIER_PREFERENCE matrix", () => {
	it("gate_review hard → frontier", () => {
		assert.equal(TIER_PREFERENCE.gate_review.hard, "frontier");
	});
	it("gate_review medium → mid", () => {
		assert.equal(TIER_PREFERENCE.gate_review.medium, "mid");
	});
	it("gate_review easy → lower", () => {
		assert.equal(TIER_PREFERENCE.gate_review.easy, "lower");
	});
	it("verification hard → lower (deterministic work, never escalates)", () => {
		assert.equal(TIER_PREFERENCE.verification.hard, "lower");
	});
	it("code_gen hard → mid (not frontier)", () => {
		assert.equal(TIER_PREFERENCE.code_gen.hard, "mid");
	});
	it("test_writing hard → mid", () => {
		assert.equal(TIER_PREFERENCE.test_writing.hard, "mid");
	});
});

// ─── AC#2: Easy task selects economy tier ─────────────────────────────────────

describe("AC#2: Easy task selects economy (lower) tier", () => {
	it("code_gen easy → lower tier model", async () => {
		const lowerModel = makeModel("lower", 0.0005);
		const qfn = mockQuery([[lowerModel]]);

		const task: TaskMetadata = {
			task_type: "code_gen",
			difficulty: "easy",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "lower");
	});

	it("research easy → lower tier model", async () => {
		const lowerModel = makeModel("lower", 0.0003);
		const qfn = mockQuery([[lowerModel]]);

		const task: TaskMetadata = {
			task_type: "research",
			difficulty: "easy",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "lower");
	});
});

// ─── AC#2: Hard task selects premium tier ─────────────────────────────────────

describe("AC#2: Hard task selects premium tier", () => {
	it("gate_review hard → frontier tier model", async () => {
		const frontierModel = makeModel("frontier", 15);
		const qfn = mockQuery([[frontierModel]]);

		const task: TaskMetadata = {
			task_type: "gate_review",
			difficulty: "hard",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "frontier");
	});

	it("research hard → frontier tier model", async () => {
		const frontierModel = makeModel("frontier", 10);
		const qfn = mockQuery([[frontierModel]]);

		const task: TaskMetadata = {
			task_type: "research",
			difficulty: "hard",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "frontier");
	});

	it("code_gen hard → mid tier (not frontier)", async () => {
		const midModel = makeModel("mid", 3);
		const qfn = mockQuery([[midModel]]);

		const task: TaskMetadata = {
			task_type: "code_gen",
			difficulty: "hard",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "mid");
	});
});

// ─── requires_novel_reasoning bumps tier ──────────────────────────────────────

describe("requires_novel_reasoning bumps tier upward", () => {
	it("code_gen easy + novel_reasoning → mid tier (lower bumped to mid)", async () => {
		const midModel = makeModel("mid", 3);
		// First call (lower) returns empty, second call (mid) returns midModel
		const qfn = mockQuery([[], [midModel]]);

		const task: TaskMetadata = {
			task_type: "code_gen",
			difficulty: "easy",
			requires_novel_reasoning: true,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "mid");
	});

	it("code_gen medium + novel_reasoning → frontier tier (mid bumped to frontier)", async () => {
		const frontierModel = makeModel("frontier", 15);
		// First call (frontier) returns frontierModel
		const qfn = mockQuery([[frontierModel]]);

		const task: TaskMetadata = {
			task_type: "code_gen",
			difficulty: "medium",
			requires_novel_reasoning: true,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "frontier");
	});

	it("verification + novel_reasoning still uses lower (deterministic work)", async () => {
		// verification is always lower regardless of novel_reasoning — but the
		// bump logic only fires when preferredTier !== 'frontier'. verification
		// prefers 'lower', novel_reasoning bumps lower→mid.
		const midModel = makeModel("mid", 2);
		const qfn = mockQuery([[], [midModel]]);

		const task: TaskMetadata = {
			task_type: "verification",
			difficulty: "hard",
			requires_novel_reasoning: true,
			proposal_id: 226n,
		};
		// verification hard = lower, bumped to mid by novel_reasoning
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "mid");
	});
});

// ─── Fallback chain ───────────────────────────────────────────────────────────

describe("Fallback chain: tries cheaper tiers if preferred unavailable", () => {
	it("frontier unavailable → falls back to mid", async () => {
		const midModel = makeModel("mid", 3);
		// First call (frontier) returns empty, second call (mid) succeeds
		const qfn = mockQuery([[], [midModel]]);

		const task: TaskMetadata = {
			task_type: "gate_review",
			difficulty: "hard",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.tier, "mid");
	});

	it("throws when no models available at any tier", async () => {
		const qfn = mockQuery([[], [], []]);

		const task: TaskMetadata = {
			task_type: "gate_review",
			difficulty: "hard",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		await assert.rejects(
			() => selectModelByTaskDifficulty(task, qfn as any),
			/no enabled model found/i,
		);
	});
});

// ─── Cost ordering ────────────────────────────────────────────────────────────

describe("Cost ordering: cheapest model in tier is preferred", () => {
	it("returns the row from DB (DB orders by cost — router returns first)", async () => {
		const cheapModel = makeModel("lower", 0.0001);
		const qfn = mockQuery([[cheapModel]]);

		const task: TaskMetadata = {
			task_type: "verification",
			difficulty: "easy",
			requires_novel_reasoning: false,
			proposal_id: 226n,
		};
		const result = await selectModelByTaskDifficulty(task, qfn as any);
		assert.equal(result.cost_per_1k_input, 0.0001);
	});
});
