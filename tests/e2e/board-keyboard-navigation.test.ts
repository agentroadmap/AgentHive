import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Test helper: simulate page navigation logic
function calculatePageDownIndex(
	currentIndex: number,
	totalItems: number,
	pageSize: number,
): number {
	return Math.min(currentIndex + pageSize, totalItems - 1);
}

function calculatePageUpIndex(currentIndex: number, pageSize: number): number {
	return Math.max(currentIndex - pageSize, 0);
}

function calculateHomeIndex(): number {
	return 0;
}

function calculateEndIndex(totalItems: number): number {
	return Math.max(totalItems - 1, 0);
}

describe("board keyboard navigation", () => {
	describe("Page Down navigation", () => {
		it("should scroll forward by page size", () => {
			const result = calculatePageDownIndex(0, 100, 20);
			assert.equal(result, 20);
		});

		it("should not exceed last item", () => {
			const result = calculatePageDownIndex(90, 100, 20);
			assert.equal(result, 99);
		});

		it("should handle small lists", () => {
			const result = calculatePageDownIndex(0, 5, 20);
			assert.equal(result, 4);
		});

		it("should handle empty lists", () => {
			const result = calculatePageDownIndex(0, 0, 20);
			assert.equal(result, -1); // Math.min(0 + 20, 0 - 1) = -1
		});
	});

	describe("Page Up navigation", () => {
		it("should scroll backward by page size", () => {
			const result = calculatePageUpIndex(40, 20);
			assert.equal(result, 20);
		});

		it("should not go below first item", () => {
			const result = calculatePageUpIndex(10, 20);
			assert.equal(result, 0);
		});

		it("should handle being at index 0", () => {
			const result = calculatePageUpIndex(0, 20);
			assert.equal(result, 0);
		});

		it("should handle small page sizes", () => {
			const result = calculatePageUpIndex(3, 1);
			assert.equal(result, 2);
		});
	});

	describe("Home navigation", () => {
		it("should jump to first item", () => {
			const result = calculateHomeIndex();
			assert.equal(result, 0);
		});

		it("should always return 0", () => {
			assert.equal(calculateHomeIndex(), 0);
			assert.equal(calculateHomeIndex(), 0);
		});
	});

	describe("End navigation", () => {
		it("should jump to last item", () => {
			const result = calculateEndIndex(100);
			assert.equal(result, 99);
		});

		it("should handle single item list", () => {
			const result = calculateEndIndex(1);
			assert.equal(result, 0);
		});

		it("should handle empty list", () => {
			const result = calculateEndIndex(0);
			assert.equal(result, 0);
		});
	});

	describe("Page size calculation", () => {
		it("should calculate page size based on list height", () => {
			const listHeight = 25;
			const pageSize = Math.max(1, listHeight - 1);
			assert.equal(pageSize, 24);
		});

		it("should have minimum page size of 1", () => {
			const listHeight = 1;
			const pageSize = Math.max(1, listHeight - 1);
			assert.equal(pageSize, 1);
		});

		it("should use default for undefined height", () => {
			const height = undefined;
			const pageSize =
				typeof height === "number" ? Math.max(1, height - 1) : 10;
			assert.equal(pageSize, 10);
		});
	});

	describe("Edge cases", () => {
		it("should handle page down at last item", () => {
			const result = calculatePageDownIndex(99, 100, 20);
			assert.equal(result, 99);
		});

		it("should handle page up at first item", () => {
			const result = calculatePageUpIndex(0, 20);
			assert.equal(result, 0);
		});

		it("should handle list with exactly page size items", () => {
			// 20 items, page size 20, at index 0
			const downResult = calculatePageDownIndex(0, 20, 20);
			assert.equal(downResult, 19); // Should go to last item (19)

			const upResult = calculatePageUpIndex(19, 20);
			assert.equal(upResult, 0); // Should go to first item
		});

		it("should handle fractional page sizes", () => {
			// If page size is fractional, Math.min returns the fractional value
			const result = calculatePageDownIndex(0, 100, 15.7);
			assert.equal(result, 15.7);
		});
	});
});
