import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import {
	type ColumnData,
	filterBoardColumns,
	shouldRebuildColumns,
} from "../../src/ui/board.ts";
import { expect } from "../support/test-utils.ts";

function createProposal(id: string, status: string): Proposal {
	return {
		id,
		title: `Title for ${id}`,
		status,
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: [],
		description: "",
	};
}

function makeColumns(proposalIds: string[][], status: string): ColumnData[] {
	return proposalIds.map((ids) => ({
		status,
		proposals: ids.map((id) => createProposal(id, status)),
	}));
}

describe("shouldRebuildColumns", () => {
	it("returns false when columns and proposal ordering are unchanged", () => {
		const previous = makeColumns([["proposal-1", "proposal-2"]], "Active");
		const next = makeColumns([["proposal-1", "proposal-2"]], "Active");

		expect(shouldRebuildColumns(previous, next)).toBe(false);
	});

	it("returns true when a column loses items", () => {
		const previous = makeColumns([["proposal-1", "proposal-2"]], "Active");
		const next = makeColumns([["proposal-1"]], "Active");

		expect(shouldRebuildColumns(previous, next)).toBe(true);
	});

	it("returns true when column proposal ordering changes", () => {
		const previous = makeColumns([["proposal-1", "proposal-2"]], "Active");
		const next = makeColumns([["proposal-2", "proposal-1"]], "Active");

		expect(shouldRebuildColumns(previous, next)).toBe(true);
	});

	it("returns true when number of columns changes", () => {
		const previous = makeColumns([["proposal-1"]], "Active");
		const next = makeColumns([["proposal-1"], ["proposal-2"]], "Active");

		expect(shouldRebuildColumns(previous, next)).toBe(true);
	});
});

describe("filterBoardColumns", () => {
	it("returns all columns when no filters are active", () => {
		const columns: ColumnData[] = [
			{ status: "Active", proposals: [createProposal("proposal-1", "Active")] },
			{ status: "Abandoned", proposals: [] },
			{ status: "Done", proposals: [createProposal("proposal-2", "Done")] },
		];

		const result = filterBoardColumns(columns, {});
		expect(result.length).toBe(3);
	});

	it("filters out empty columns when hideEmpty is true", () => {
		const columns: ColumnData[] = [
			{ status: "Active", proposals: [createProposal("proposal-1", "Active")] },
			{ status: "Potential", proposals: [] },
			{ status: "Done", proposals: [createProposal("proposal-2", "Done")] },
		];

		const result = filterBoardColumns(columns, { hideEmpty: true });
		expect(result.length).toBe(2);
		expect(result[0]?.status).toBe("Active");
		expect(result[1]?.status).toBe("Done");
	});

	it("filters out abandoned columns when hideAbandoned is true", () => {
		const columns: ColumnData[] = [
			{ status: "Active", proposals: [createProposal("proposal-1", "Active")] },
			{
				status: "Abandoned",
				proposals: [createProposal("proposal-2", "Abandoned")],
			},
			{ status: "Done", proposals: [createProposal("proposal-3", "Done")] },
		];

		const result = filterBoardColumns(columns, {
			hiddenStatuses: ["Abandoned"],
		});
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0]?.status, "Active");
		assert.strictEqual(result[1]?.status, "Done");
	});

	it("applies both filters simultaneously", () => {
		const columns: ColumnData[] = [
			{ status: "Active", proposals: [createProposal("proposal-1", "Active")] },
			{ status: "Potential", proposals: [] },
			{ status: "Abandoned", proposals: [] },
			{ status: "Done", proposals: [createProposal("proposal-2", "Done")] },
		];

		const result = filterBoardColumns(columns, { hideEmpty: true });
		expect(result.length).toBe(2);
		expect(result[0]?.status).toBe("Active");
		expect(result[1]?.status).toBe("Done");
	});

	it("keeps abandoned columns with proposals when hideEmpty is true", () => {
		const columns: ColumnData[] = [
			{ status: "Active", proposals: [createProposal("proposal-1", "Active")] },
			{
				status: "Abandoned",
				proposals: [createProposal("proposal-2", "Abandoned")],
			},
			{ status: "Potential", proposals: [] },
		];

		const result = filterBoardColumns(columns, { hideEmpty: true });
		expect(result.length).toBe(2);
		expect(result[0]?.status).toBe("Active");
		expect(result[1]?.status).toBe("Abandoned");
	});
});
