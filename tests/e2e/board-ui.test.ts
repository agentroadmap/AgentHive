import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import type { ColumnData } from "../../src/ui/board.ts";
import { shouldRebuildColumns } from "../../src/ui/board.ts";
import { expect } from "../support/test-utils.ts";

// Helper to create a minimal valid Proposal for testing
const createTestProposal = (
	id: string,
	title: string,
	status: string,
): Proposal => ({
	id,
	title,
	status,
	assignee: [],
	createdDate: "2025-01-01",
	labels: [],
	dependencies: [],
});

describe("Board TUI Logic", () => {
	describe("shouldRebuildColumns", () => {
		it("should return true if column counts differ", () => {
			const current: ColumnData[] = [{ status: "ToDo", proposals: [] }];
			const next: ColumnData[] = [
				{ status: "ToDo", proposals: [] },
				{ status: "Complete", proposals: [] },
			];
			expect(shouldRebuildColumns(current, next)).toBe(true);
		});

		it("should return true if statuses differ", () => {
			const current: ColumnData[] = [{ status: "ToDo", proposals: [] }];
			const next: ColumnData[] = [{ status: "Complete", proposals: [] }];
			expect(shouldRebuildColumns(current, next)).toBe(true);
		});

		it("should return true if proposal counts differ", () => {
			const proposal1 = createTestProposal("1", "t1", "ToDo");
			const current: ColumnData[] = [
				{ status: "ToDo", proposals: [proposal1] },
			];
			const next: ColumnData[] = [{ status: "ToDo", proposals: [] }];
			expect(shouldRebuildColumns(current, next)).toBe(true);
		});

		it("should return true if proposal IDs differ (order change)", () => {
			const proposal1 = createTestProposal("1", "t1", "ToDo");
			const proposal2 = createTestProposal("2", "t2", "ToDo");

			const current: ColumnData[] = [
				{ status: "ToDo", proposals: [proposal1, proposal2] },
			];
			const next: ColumnData[] = [
				{ status: "ToDo", proposals: [proposal2, proposal1] },
			];
			expect(shouldRebuildColumns(current, next)).toBe(true);
		});

		it("should return false if columns and proposals are identical", () => {
			const proposal1 = createTestProposal("1", "t1", "ToDo");
			const proposal2 = createTestProposal("2", "t2", "ToDo");

			const current: ColumnData[] = [
				{ status: "ToDo", proposals: [proposal1, proposal2] },
			];
			const next: ColumnData[] = [
				{ status: "ToDo", proposals: [proposal1, proposal2] },
			];
			expect(shouldRebuildColumns(current, next)).toBe(false);
		});
	});
});
