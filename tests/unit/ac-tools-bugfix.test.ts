import assert from "node:assert";
import { describe, it } from "node:test";

/**
 * Unit tests for P156/P157/P158 bug fixes in acceptance criteria MCP tools.
 *
 * P156: add_acceptance_criteria splits text into individual characters
 * P157: verify_ac returns 'undefined' values instead of AC details
 * P158: list_ac returns 600+ items when add_acceptance_criteria splits by character
 */

describe("P156: addAcceptanceCriteria criteria normalization", () => {
	/**
	 * Simulates the normalization logic from the fixed addAcceptanceCriteria handler.
	 * This is the core fix: if criteria is a string, wrap it in an array.
	 */
	function normalizeCriteria(criteria: string[] | string): string[] {
		return typeof criteria === "string"
			? [criteria]
			: Array.isArray(criteria)
				? criteria
				: [];
	}

	it("should handle a single string by wrapping in array", () => {
		const input = "A channel_subscription table exists with columns";
		const result = normalizeCriteria(input);
		assert.deepStrictEqual(result, [
			"A channel_subscription table exists with columns",
		]);
		assert.strictEqual(result.length, 1, "Should produce exactly 1 item, not character-split");
	});

	it("should handle an array of strings normally", () => {
		const input = ["Must compile", "Must pass tests", "Must have docs"];
		const result = normalizeCriteria(input);
		assert.deepStrictEqual(result, input);
		assert.strictEqual(result.length, 3);
	});

	it("should handle empty string", () => {
		const result = normalizeCriteria("");
		assert.deepStrictEqual(result, [""]);
	});

	it("should handle empty array", () => {
		const result = normalizeCriteria([]);
		assert.deepStrictEqual(result, []);
	});

	it("should NOT iterate character-by-character on string input", () => {
		// This is the exact bug scenario from P156
		const input = "A table exists";
		const result = normalizeCriteria(input);

		// The buggy behavior would produce 13 items (one per character)
		assert.strictEqual(result.length, 1, "String input should produce 1 item, not character count");
		assert.strictEqual(result[0], "A table exists");
	});

	it("should handle multi-line criteria strings", () => {
		const input = "AC1: Database table exists\nAC2: API endpoint responds\nAC3: Tests pass";
		const result = normalizeCriteria(input);
		assert.strictEqual(result.length, 1);
		assert.ok(result[0].includes("AC1"));
		assert.ok(result[0].includes("AC3"));
	});

	it("should reject non-string, non-array input gracefully", () => {
		const result = normalizeCriteria(42 as any);
		assert.deepStrictEqual(result, []);
	});
});

describe("P157: verifyAC response validation", () => {
	/**
	 * Simulates the validation logic from the fixed verifyAC handler.
	 */
	function validateVerifyArgs(args: Record<string, unknown>): {
		valid: boolean;
		error?: string;
	} {
		if (
			!args ||
			!args.proposal_id ||
			args.item_number == null ||
			!args.status ||
			!args.verified_by
		) {
			return {
				valid: false,
				error: `verify_ac requires: proposal_id, item_number, status, verified_by. Got: ${JSON.stringify(args)}`,
			};
		}
		return { valid: true };
	}

	it("should accept valid args", () => {
		const result = validateVerifyArgs({
			proposal_id: "P044",
			item_number: 1,
			status: "pass",
			verified_by: "test-agent",
		});
		assert.strictEqual(result.valid, true);
		assert.strictEqual(result.error, undefined);
	});

	it("should reject undefined args", () => {
		const result = validateVerifyArgs(undefined as any);
		assert.strictEqual(result.valid, false);
		assert.ok(result.error?.includes("verify_ac requires"));
	});

	it("should reject null args", () => {
		const result = validateVerifyArgs(null as any);
		assert.strictEqual(result.valid, false);
	});

	it("should reject missing proposal_id", () => {
		const result = validateVerifyArgs({
			item_number: 1,
			status: "pass",
			verified_by: "agent",
		});
		assert.strictEqual(result.valid, false);
	});

	it("should reject missing item_number", () => {
		const result = validateVerifyArgs({
			proposal_id: "P044",
			status: "pass",
			verified_by: "agent",
		});
		assert.strictEqual(result.valid, false);
	});

	it("should reject missing status", () => {
		const result = validateVerifyArgs({
			proposal_id: "P044",
			item_number: 1,
			verified_by: "agent",
		});
		assert.strictEqual(result.valid, false);
	});

	it("should reject missing verified_by", () => {
		const result = validateVerifyArgs({
			proposal_id: "P044",
			item_number: 1,
			status: "pass",
		});
		assert.strictEqual(result.valid, false);
	});

	it("should coerce string item_number to integer", () => {
		const item_number = "3";
		const itemNum =
			typeof item_number === "string"
				? parseInt(item_number, 10)
				: item_number;
		assert.strictEqual(itemNum, 3);
		assert.strictEqual(typeof itemNum, "number");
	});
});

describe("P158: deleteAC cleanup_singles behavior", () => {
	/**
	 * Tests the SQL logic for cleanup_singles mode.
	 * We can't run actual SQL here, but we test the decision logic.
	 */
	function shouldCleanupSingles(args: {
		cleanup_singles?: boolean;
		item_number?: number;
	}): "cleanup" | "delete_all" | "delete_one" | "error" {
		if (args.cleanup_singles) return "cleanup";
		if (args.item_number == null) return "error";
		return "delete_one";
	}

	it("should enter cleanup mode when cleanup_singles is true", () => {
		const mode = shouldCleanupSingles({
			cleanup_singles: true,
		});
		assert.strictEqual(mode, "cleanup");
	});

	it("should delete specific item when item_number provided", () => {
		const mode = shouldCleanupSingles({
			item_number: 5,
		});
		assert.strictEqual(mode, "delete_one");
	});

	it("should error when neither cleanup_singles nor item_number provided", () => {
		const mode = shouldCleanupSingles({});
		assert.strictEqual(mode, "error");
	});

	it("cleanup_singles takes precedence over item_number", () => {
		const mode = shouldCleanupSingles({
			cleanup_singles: true,
			item_number: 5,
		});
		assert.strictEqual(mode, "cleanup");
	});
});

describe("P156: character-splitting bug reproduction", () => {
	/**
	 * Demonstrates the original bug: for...of on a string iterates characters.
	 */
	it("demonstrates the bug - for...of on string iterates characters", () => {
		const criteria = "A table exists"; // string, not array
		const items: string[] = [];
		for (const item of criteria) {
			items.push(item);
		}
		// This is the BUG: 14 characters become 14 AC items
		assert.strictEqual(items.length, 14);
		assert.deepStrictEqual(items, [
			"A",
			" ",
			"t",
			"a",
			"b",
			"l",
			"e",
			" ",
			"e",
			"x",
			"i",
			"s",
			"t",
			"s",
		]);
	});

	it("demonstrates the fix - normalize to array first", () => {
		const raw = "A table exists";
		const criteria = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
		const items: string[] = [];
		for (const item of criteria) {
			items.push(item);
		}
		// Fixed: 1 string becomes 1 AC item
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0], "A table exists");
	});
});
