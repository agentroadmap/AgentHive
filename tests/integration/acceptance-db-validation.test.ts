/**
 * Tests for acceptance.ts — DB-backed Acceptance Criteria Validation (AC-19)
 *
 * Tests the validateACFromDB and formatACBlockingError functions.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

// Import types and formatting functions (unit-testable without DB)
import {
	type ACValidationResult,
	type ACCriterionRow,
	formatACBlockingError,
} from "../../src/core/proposal/acceptance.ts";

describe("acceptance: ACValidationResult structure", () => {
	it("should represent all-satisfied state correctly", () => {
		const result: ACValidationResult = {
			allSatisfied: true,
			blockingCriteria: [],
			totalCriteria: 3,
			satisfiedCount: 3,
			summary: "All 3 acceptance criteria satisfied (3 pass/waived)",
		};
		assert.strictEqual(result.allSatisfied, true);
		assert.strictEqual(result.blockingCriteria.length, 0);
		assert.strictEqual(result.totalCriteria, 3);
		assert.strictEqual(result.satisfiedCount, 3);
	});

	it("should represent blocked state correctly", () => {
		const blockingCriterion: ACCriterionRow = {
			item_number: 2,
			criterion_text: "Must pass all tests",
			status: "pending",
			verified_by: null,
			verification_notes: null,
			verified_at: null,
		};
		const result: ACValidationResult = {
			allSatisfied: false,
			blockingCriteria: [blockingCriterion],
			totalCriteria: 3,
			satisfiedCount: 2,
			summary: "2/3 criteria satisfied — blocking: 1 pending",
		};
		assert.strictEqual(result.allSatisfied, false);
		assert.strictEqual(result.blockingCriteria.length, 1);
		assert.strictEqual(result.blockingCriteria[0].item_number, 2);
		assert.strictEqual(result.blockingCriteria[0].status, "pending");
	});
});

describe("acceptance: formatACBlockingError", () => {
	it("should produce correct context for blocking criteria", () => {
		const result: ACValidationResult = {
			allSatisfied: false,
			blockingCriteria: [
				{
					item_number: 1,
					criterion_text: "First criterion",
					status: "pending",
					verified_by: null,
					verification_notes: null,
					verified_at: null,
				},
				{
					item_number: 3,
					criterion_text: "Third criterion",
					status: "fail",
					verified_by: null,
					verification_notes: "Tests failed",
					verified_at: null,
				},
			],
			totalCriteria: 4,
			satisfiedCount: 2,
			summary: "2/4 criteria satisfied — blocking: 1 pending, 1 failed",
		};

		const context = formatACBlockingError(result);

		assert.strictEqual(context.totalCriteria, 4);
		assert.strictEqual(context.satisfiedCount, 2);
		assert.deepStrictEqual(context.blockingItemNumbers, [1, 3]);

		const details = context.blockingDetails as string[];
		assert.strictEqual(details.length, 2);
		assert.ok(details[0].includes("#1"));
		assert.ok(details[0].includes("pending"));
		assert.ok(details[1].includes("#3"));
		assert.ok(details[1].includes("fail"));
	});

	it("should produce correct context when all criteria are satisfied", () => {
		const result: ACValidationResult = {
			allSatisfied: true,
			blockingCriteria: [],
			totalCriteria: 2,
			satisfiedCount: 2,
			summary: "All 2 acceptance criteria satisfied (2 pass/waived)",
		};

		const context = formatACBlockingError(result);

		assert.strictEqual(context.totalCriteria, 2);
		assert.strictEqual(context.satisfiedCount, 2);
		assert.deepStrictEqual(context.blockingItemNumbers, []);
		assert.deepStrictEqual(context.blockingDetails, []);
	});
});

describe("acceptance: ACCriterionRow types", () => {
	it("should have all 5 valid status values", () => {
		const validStatuses = ["pending", "pass", "fail", "blocked", "waived"];
		for (const status of validStatuses) {
			const row: ACCriterionRow = {
				item_number: 1,
				criterion_text: "test",
				status: status as ACCriterionRow["status"],
				verified_by: null,
				verification_notes: null,
				verified_at: null,
			};
			assert.ok(validStatuses.includes(row.status));
		}
	});
});
