/**
 * P226 AC#5 + AC#8: Unit tests for stageEnforcer()
 *
 * Verifies:
 *  - Non-gated target stages pass without checking prerequisites
 *  - TestWriting requires CodeReview (AC#5)
 *  - Merge requires CodeReview + TestWriting + TestExecution (AC#8)
 *  - StageEnforcerError.missingStages lists only the incomplete stages
 *  - STANDARD_RFC_STAGES defines the expected sequence
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	stageEnforcer,
	StageEnforcerError,
	STANDARD_RFC_STAGES,
	type ProposalStub,
	type StageName,
} from "../../src/gate_pipeline/workflow_stages.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROPOSAL: ProposalStub = {
	id: 226n,
	display_id: "P226",
	title: "Tiered LLM intelligence",
};

/**
 * Build a mock queryFn for stageEnforcer.
 *
 * isStageComplete() issues one COUNT query per prerequisite stage.
 * `completedStages` lists the StageName values that should return count=1.
 * All others return count=0.
 *
 * stageToPrefix mapping (from workflow_stages.ts):
 *   CodeReview  → "code-review"
 *   TestWriting → "test-writing"
 *   TestExecution → "test-execution"
 */
function mockStageQuery(completedStages: StageName[]) {
	const prefixMap: Record<string, StageName> = {
		"code-review": "CodeReview",
		"test-writing": "TestWriting",
		"test-execution": "TestExecution",
	};

	return async (text: string, params?: unknown[]) => {
		// Extract the LIKE pattern from params (second param after proposal_id)
		const likePattern = (params?.[1] as string) ?? "";
		const prefix = likePattern.replace("/%", "");
		const stageName = prefixMap[prefix];

		const count =
			stageName && completedStages.includes(stageName) ? "1" : "0";

		return { rows: [{ count }] };
	};
}

// ─── STANDARD_RFC_STAGES ─────────────────────────────────────────────────────

describe("STANDARD_RFC_STAGES sequence", () => {
	it("contains 8 stages in order", () => {
		const names = STANDARD_RFC_STAGES.map((s) => s.name);
		assert.deepEqual(names, [
			"Draft",
			"Review",
			"Develop",
			"CodeReview",
			"TestWriting",
			"TestExecution",
			"Merge",
			"Complete",
		]);
	});

	it("Develop allows transition to CodeReview", () => {
		const develop = STANDARD_RFC_STAGES.find((s) => s.name === "Develop");
		assert.ok(develop?.allows_transition_to.includes("CodeReview"));
	});

	it("TestExecution allows transition to Merge and Develop", () => {
		const te = STANDARD_RFC_STAGES.find((s) => s.name === "TestExecution");
		assert.ok(te?.allows_transition_to.includes("Merge"));
		assert.ok(te?.allows_transition_to.includes("Develop"));
	});

	it("Complete has no allowed transitions (terminal state)", () => {
		const complete = STANDARD_RFC_STAGES.find((s) => s.name === "Complete");
		assert.deepEqual(complete?.allows_transition_to, []);
	});

	it("TestExecution agent_tier is tool (zero LLM cost)", () => {
		const te = STANDARD_RFC_STAGES.find((s) => s.name === "TestExecution");
		assert.equal(te?.agent_tier, "tool");
	});

	it("Review agent_tier is frontier (gate quality)", () => {
		const review = STANDARD_RFC_STAGES.find((s) => s.name === "Review");
		assert.equal(review?.agent_tier, "frontier");
	});
});

// ─── Non-gated targets bypass prereq check ───────────────────────────────────

describe("Non-gated target stages skip prerequisite check", () => {
	const ungatedStages: StageName[] = [
		"Draft",
		"Review",
		"Develop",
		"CodeReview",
		"TestExecution",
		"Complete",
	];

	for (const stage of ungatedStages) {
		it(`target=${stage} → no query issued, no throw`, async () => {
			let queryCalled = false;
			const qfn = async () => {
				queryCalled = true;
				return { rows: [] };
			};

			await stageEnforcer(PROPOSAL, stage, qfn as any);
			assert.equal(queryCalled, false, `Expected no DB query for target=${stage}`);
		});
	}
});

// ─── AC#5: TestWriting requires CodeReview ────────────────────────────────────

describe("AC#5: TestWriting gate — requires CodeReview", () => {
	it("CodeReview complete → TestWriting passes", async () => {
		const qfn = mockStageQuery(["CodeReview"]);
		await assert.doesNotReject(() =>
			stageEnforcer(PROPOSAL, "TestWriting", qfn as any),
		);
	});

	it("CodeReview missing → throws StageEnforcerError", async () => {
		const qfn = mockStageQuery([]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "TestWriting", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(err.missingStages, ["CodeReview"]);
				assert.ok(err.message.includes("TestWriting"));
				assert.ok(err.message.includes("P226"));
				return true;
			},
		);
	});
});

// ─── AC#8: All prerequisites complete → Merge allowed ────────────────────────

describe("AC#8: All prerequisites complete → Merge passes", () => {
	it("all 3 prereqs complete → stageEnforcer resolves without throwing", async () => {
		const qfn = mockStageQuery(["CodeReview", "TestWriting", "TestExecution"]);
		await assert.doesNotReject(() =>
			stageEnforcer(PROPOSAL, "Merge", qfn as any),
		);
	});
});

// ─── AC#8: Missing prerequisites → throws StageEnforcerError ─────────────────

describe("AC#8: Missing prerequisites → throws StageEnforcerError", () => {
	it("no prereqs complete → throws listing all 3 missing", async () => {
		const qfn = mockStageQuery([]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError, "should be StageEnforcerError");
				assert.ok(
					err.message.includes("P226"),
					"error message should reference the display_id",
				);
				assert.deepEqual(
					err.missingStages.sort(),
					["CodeReview", "TestExecution", "TestWriting"],
				);
				return true;
			},
		);
	});

	it("only CodeReview complete → throws with TestWriting + TestExecution missing", async () => {
		const qfn = mockStageQuery(["CodeReview"]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(
					err.missingStages.sort(),
					["TestExecution", "TestWriting"],
				);
				return true;
			},
		);
	});

	it("only TestExecution missing → throws with just TestExecution", async () => {
		const qfn = mockStageQuery(["CodeReview", "TestWriting"]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(err.missingStages, ["TestExecution"]);
				return true;
			},
		);
	});

	it("only TestWriting missing → throws with just TestWriting", async () => {
		const qfn = mockStageQuery(["CodeReview", "TestExecution"]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(err.missingStages, ["TestWriting"]);
				return true;
			},
		);
	});

	it("only CodeReview missing → throws with just CodeReview", async () => {
		const qfn = mockStageQuery(["TestWriting", "TestExecution"]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(err.missingStages, ["CodeReview"]);
				return true;
			},
		);
	});
});

// ─── StageEnforcerError shape ─────────────────────────────────────────────────

describe("StageEnforcerError structure", () => {
	it("name is StageEnforcerError", async () => {
		const qfn = mockStageQuery([]);
		try {
			await stageEnforcer(PROPOSAL, "Merge", qfn as any);
			assert.fail("should have thrown");
		} catch (err: unknown) {
			assert.ok(err instanceof StageEnforcerError);
			assert.equal(err.name, "StageEnforcerError");
		}
	});

	it("error message includes display_id and 'Merge'", async () => {
		const qfn = mockStageQuery([]);
		try {
			await stageEnforcer(PROPOSAL, "Merge", qfn as any);
			assert.fail("should have thrown");
		} catch (err: unknown) {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes("Merge"));
			assert.ok(err.message.includes("P226"));
		}
	});
});
