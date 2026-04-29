import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { getPool } from "../../src/infra/postgres/pool.ts";
import {
	loadStateNames,
	getRegistry,
	getView,
	Maturity,
	isTerminal,
	isGateable,
	nextOnMature,
	isValidTransition,
	gateForTransition,
	RfcStates,
} from "../../src/core/workflow/state-names.ts";

describe("state-names", () => {
	before(async () => {
		const pool = getPool();
		await loadStateNames(pool);
	});

	describe("Maturity constant", () => {
		it("should freeze Maturity object", () => {
			assert.ok(Object.isFrozen(Maturity));
		});

		it("should have all expected maturity values", () => {
			assert.equal(Maturity.NEW, "new");
			assert.equal(Maturity.ACTIVE, "active");
			assert.equal(Maturity.MATURE, "mature");
			assert.equal(Maturity.OBSOLETE, "obsolete");
		});

		it("should not allow modification", () => {
			assert.throws(() => {
				(Maturity as any).NEW = "invalid";
			});
		});
	});

	describe("Registry loading and access", () => {
		it("should load registry from database", () => {
			const registry = getRegistry();
			assert.ok(registry != null);
		});

		it("getRegistry() should not throw after load", () => {
			// Already loaded in before(); just verify no throw.
			const registry = getRegistry();
			assert.ok(registry != null);
		});
	});

	describe("RFC workflow template", () => {
		it("should return RFC view", () => {
			const view = getView("Standard RFC");
			assert.ok(view != null);
			assert.equal(view.template, "Standard RFC");
		});

		it("should have expected stages in RFC", () => {
			const view = getView("Standard RFC");
			const stageNames = view.stages.map((s) => s.name);
			assert.ok(stageNames.includes("DRAFT"));
			assert.ok(stageNames.includes("REVIEW"));
			assert.ok(stageNames.includes("DEVELOP"));
			// P227: quality gates inserted between DEVELOP and MERGE
			assert.ok(stageNames.includes("CODE_REVIEW"));
			assert.ok(stageNames.includes("TEST_WRITING"));
			assert.ok(stageNames.includes("TEST_EXECUTION"));
			assert.ok(stageNames.includes("MERGE"));
			assert.ok(stageNames.includes("COMPLETE"));
			assert.ok(stageNames.includes("REJECTED"));
			assert.ok(stageNames.includes("DISCARDED"));
		});

		it("should mark COMPLETE as non-terminal", () => {
			assert.equal(isTerminal("Standard RFC", "COMPLETE"), false);
		});

		it("should mark DRAFT as non-terminal", () => {
			assert.equal(isTerminal("Standard RFC", "DRAFT"), false);
		});

		it("should mark REJECTED as terminal", () => {
			assert.equal(isTerminal("Standard RFC", "REJECTED"), true);
		});

		it("should mark DISCARDED as terminal", () => {
			assert.equal(isTerminal("Standard RFC", "DISCARDED"), true);
		});

		it("should mark REVIEW as gateable", () => {
			assert.equal(isGateable("Standard RFC", "REVIEW"), true);
		});

		it("should mark DEVELOP as gateable", () => {
			assert.equal(isGateable("Standard RFC", "DEVELOP"), true);
		});

		it("should return nextOnMature for DRAFT", () => {
			const next = nextOnMature("Standard RFC", "DRAFT");
			assert.equal(next, "REVIEW");
		});

		it("should return null nextOnMature for REJECTED (terminal stage)", () => {
			const next = nextOnMature("Standard RFC", "REJECTED");
			assert.equal(next, null);
		});

		it("should validate valid transition DRAFT -> REVIEW", () => {
			assert.equal(isValidTransition("Standard RFC", "DRAFT", "REVIEW"), true);
		});

		it("should reject invalid transition DRAFT -> COMPLETE", () => {
			assert.equal(isValidTransition("Standard RFC", "DRAFT", "COMPLETE"), false);
		});

		it("should validate REVIEW -> DEVELOP transition", () => {
			assert.equal(isValidTransition("Standard RFC", "REVIEW", "DEVELOP"), true);
		});

		// P227: DEVELOP→MERGE is no longer a direct transition; CODE_REVIEW is next
		it("DEVELOP -> CODE_REVIEW is the new forward transition from DEVELOP", () => {
			assert.equal(isValidTransition("Standard RFC", "DEVELOP", "CODE_REVIEW"), true);
		});

		it("DEVELOP -> MERGE is blocked (quality gates mandatory)", () => {
			assert.equal(isValidTransition("Standard RFC", "DEVELOP", "MERGE"), false);
		});

		it("should validate MERGE -> COMPLETE transition", () => {
			assert.equal(isValidTransition("Standard RFC", "MERGE", "COMPLETE"), true);
		});

		it("should check gating on REVIEW -> DEVELOP transition", () => {
			const gating = gateForTransition("Standard RFC", "REVIEW", "DEVELOP");
			assert.ok(gating === null || typeof gating === "string");
		});

		// P227: DEVELOP→MERGE no longer exists; DEVELOP→CODE_REVIEW is the forward path
		it("should check gating on DEVELOP -> CODE_REVIEW transition", () => {
			const gating = gateForTransition("Standard RFC", "DEVELOP", "CODE_REVIEW");
			assert.ok(gating === null || typeof gating === "string");
		});

		it("should check gating on MERGE -> COMPLETE transition", () => {
			const gating = gateForTransition("Standard RFC", "MERGE", "COMPLETE");
			assert.ok(gating === null || typeof gating === "string");
		});

		it("should have no gating on DRAFT -> DISCARDED transition", () => {
			const gating = gateForTransition("Standard RFC", "DRAFT", "DISCARDED");
			assert.equal(gating, null);
		});
	});

	describe("RFC convenience accessors", () => {
		it("should return DRAFT via RfcStates", () => {
			assert.equal(RfcStates.DRAFT, "DRAFT");
		});

		it("should return REVIEW via RfcStates", () => {
			assert.equal(RfcStates.REVIEW, "REVIEW");
		});

		it("should return DEVELOP via RfcStates", () => {
			assert.equal(RfcStates.DEVELOP, "DEVELOP");
		});

		it("should return MERGE via RfcStates", () => {
			assert.equal(RfcStates.MERGE, "MERGE");
		});

		it("should return COMPLETE via RfcStates", () => {
			assert.equal(RfcStates.COMPLETE, "COMPLETE");
		});

		it("should return REJECTED via RfcStates", () => {
			assert.equal(RfcStates.REJECTED, "REJECTED");
		});

		it("should return DISCARDED via RfcStates", () => {
			assert.equal(RfcStates.DISCARDED, "DISCARDED");
		});
	});

	describe("Other workflow templates", () => {
		it("should return Quick Fix view", () => {
			const view = getView("Quick Fix");
			assert.ok(view != null);
			assert.equal(view.template, "Quick Fix");
		});

		it("should have Quick Fix stages", () => {
			const view = getView("Quick Fix");
			assert.ok(view.stages.length > 0);
		});

		it("should return Code Review Pipeline view", () => {
			const view = getView("Code Review Pipeline");
			assert.ok(view != null);
			assert.equal(view.template, "Code Review Pipeline");
		});
	});

	describe("Edge cases", () => {
		it("should throw for unknown template", () => {
			assert.throws(() => getView("NonExistentTemplate"));
		});

		it("should return false for unknown template predicates", () => {
			assert.equal(isTerminal("Unknown", "DRAFT"), false);
			assert.equal(isGateable("Unknown", "REVIEW"), false);
		});

		it("should return null for unknown template transitions", () => {
			assert.equal(nextOnMature("Unknown", "DRAFT"), null);
			assert.equal(gateForTransition("Unknown", "DRAFT", "REVIEW"), null);
		});

		it("should handle case-insensitive template lookups", () => {
			const view1 = getView("Standard RFC");
			const view2 = getView("standard rfc");
			assert.equal(view1.template, view2.template);
		});
	});

	describe("terminal stages predicates", () => {
		it("should include all terminal stages in view", () => {
			const view = getView("Standard RFC");
			for (const stage of view.terminalStages) {
				assert.equal(isTerminal("Standard RFC", stage), true);
			}
		});

		it("should exclude non-terminal stages from terminalStages", () => {
			const view = getView("Standard RFC");
			const nonTerminal = view.stages.find((s) => !s.isTerminal);
			if (nonTerminal) {
				assert.ok(!view.terminalStages.includes(nonTerminal.name));
			}
		});
	});
});
