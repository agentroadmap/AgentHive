import assert from "node:assert";
import { describe, test } from "node:test";
import {
	compareProposalIds,
	parseProposalId,
	sortByPriority,
	sortByProposalId,
	sortProposals,
} from "../../src/utils/proposal-sorting.ts";
import { expect } from "../support/test-utils.ts";

describe("parseProposalId", () => {
	test("parses simple proposal IDs", () => {
		expect(parseProposalId("proposal-1")).toEqual([1]);
		expect(parseProposalId("proposal-10")).toEqual([10]);
		expect(parseProposalId("proposal-100")).toEqual([100]);
	});

	test("parses decimal proposal IDs", () => {
		expect(parseProposalId("proposal-1.1")).toEqual([1, 1]);
		expect(parseProposalId("proposal-1.2.3")).toEqual([1, 2, 3]);
		expect(parseProposalId("proposal-10.20.30")).toEqual([10, 20, 30]);
	});

	test("handles IDs without proposal- prefix", () => {
		expect(parseProposalId("5")).toEqual([5]);
		expect(parseProposalId("5.1")).toEqual([5, 1]);
	});

	test("handles invalid numeric parts", () => {
		expect(parseProposalId("proposal-abc")).toEqual([0]);
		expect(parseProposalId("proposal-1.abc.2")).toEqual([2]); // Mixed numeric/non-numeric extracts trailing number
	});

	test("handles IDs with trailing numbers", () => {
		expect(parseProposalId("proposal-draft")).toEqual([0]);
		expect(parseProposalId("proposal-draft2")).toEqual([2]);
		expect(parseProposalId("proposal-draft10")).toEqual([10]);
		expect(parseProposalId("draft2")).toEqual([2]);
		expect(parseProposalId("abc123")).toEqual([123]);
	});
});

describe("compareProposalIds", () => {
	test("sorts simple proposal IDs numerically", () => {
		expect(compareProposalIds("proposal-2", "proposal-10")).toBeLessThan(0);
		expect(compareProposalIds("proposal-10", "proposal-2")).toBeGreaterThan(0);
		expect(compareProposalIds("proposal-5", "proposal-5")).toBe(0);
	});

	test("sorts decimal proposal IDs correctly", () => {
		expect(compareProposalIds("proposal-2.1", "proposal-2.2")).toBeLessThan(0);
		expect(compareProposalIds("proposal-2.2", "proposal-2.10")).toBeLessThan(0);
		expect(compareProposalIds("proposal-2.10", "proposal-2.2")).toBeGreaterThan(
			0,
		);
	});

	test("parent proposals come before subproposals", () => {
		expect(compareProposalIds("proposal-2", "proposal-2.1")).toBeLessThan(0);
		expect(compareProposalIds("proposal-2.1", "proposal-2")).toBeGreaterThan(0);
	});

	test("handles different depth levels", () => {
		expect(compareProposalIds("proposal-1.1.1", "proposal-1.2")).toBeLessThan(
			0,
		);
		expect(
			compareProposalIds("proposal-1.2", "proposal-1.1.1"),
		).toBeGreaterThan(0);
	});

	test("sorts IDs with trailing numbers", () => {
		expect(
			compareProposalIds("proposal-draft", "proposal-draft2"),
		).toBeLessThan(0);
		expect(
			compareProposalIds("proposal-draft2", "proposal-draft10"),
		).toBeLessThan(0);
		expect(
			compareProposalIds("proposal-draft10", "proposal-draft2"),
		).toBeGreaterThan(0);
	});
});

describe("sortByProposalId", () => {
	test("sorts array of proposals by ID numerically", () => {
		const proposals = [
			{ id: "proposal-10", title: "Proposal 10" },
			{ id: "proposal-2", title: "Proposal 2" },
			{ id: "proposal-1", title: "Proposal 1" },
			{ id: "proposal-20", title: "Proposal 20" },
			{ id: "proposal-3", title: "Proposal 3" },
		];

		const sorted = sortByProposalId(proposals);
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-3",
			"proposal-10",
			"proposal-20",
		]);
	});

	test("sorts proposals with decimal IDs correctly", () => {
		const proposals = [
			{ id: "proposal-2.10", title: "Subproposal 2.10" },
			{ id: "proposal-2.2", title: "Subproposal 2.2" },
			{ id: "proposal-2", title: "Proposal 2" },
			{ id: "proposal-1", title: "Proposal 1" },
			{ id: "proposal-2.1", title: "Subproposal 2.1" },
		];

		const sorted = sortByProposalId(proposals);
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-2.1",
			"proposal-2.2",
			"proposal-2.10",
		]);
	});

	test("handles mixed simple and decimal IDs", () => {
		const proposals = [
			{ id: "proposal-10", title: "Proposal 10" },
			{ id: "proposal-2.1", title: "Subproposal 2.1" },
			{ id: "proposal-2", title: "Proposal 2" },
			{ id: "proposal-1", title: "Proposal 1" },
			{ id: "proposal-10.1", title: "Subproposal 10.1" },
			{ id: "proposal-3", title: "Proposal 3" },
		];

		const sorted = sortByProposalId(proposals);
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-2.1",
			"proposal-3",
			"proposal-10",
			"proposal-10.1",
		]);
	});

	test("preserves original array", () => {
		const proposals = [
			{ id: "proposal-3", title: "Proposal 3" },
			{ id: "proposal-1", title: "Proposal 1" },
			{ id: "proposal-2", title: "Proposal 2" },
		];

		const original = [...proposals];
		sortByProposalId(proposals);

		// Original array order should be preserved
		assert.deepStrictEqual(proposals, original);
	});
});

describe("sortByPriority", () => {
	test("sorts proposals by priority order: high > medium > low > undefined", () => {
		const proposals = [
			{ id: "proposal-1", priority: "low" as const },
			{ id: "proposal-2", priority: "high" as const },
			{ id: "proposal-3" }, // no priority
			{ id: "proposal-4", priority: "medium" as const },
			{ id: "proposal-5", priority: "high" as const },
		];

		const sorted = sortByPriority(proposals);
		expect(sorted.map((t) => ({ id: t.id, priority: t.priority }))).toEqual([
			{ id: "proposal-2", priority: "high" },
			{ id: "proposal-5", priority: "high" },
			{ id: "proposal-4", priority: "medium" },
			{ id: "proposal-1", priority: "low" },
			{ id: "proposal-3", priority: undefined },
		]);
	});

	test("sorts proposals with same priority by proposal ID", () => {
		const proposals = [
			{ id: "proposal-10", priority: "high" as const },
			{ id: "proposal-2", priority: "high" as const },
			{ id: "proposal-20", priority: "medium" as const },
			{ id: "proposal-1", priority: "medium" as const },
		];

		const sorted = sortByPriority(proposals);
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-2",
			"proposal-10",
			"proposal-1",
			"proposal-20",
		]);
	});

	test("handles all undefined priorities", () => {
		const proposals = [
			{ id: "proposal-3" },
			{ id: "proposal-1" },
			{ id: "proposal-2" },
		];

		const sorted = sortByPriority(proposals);
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-3",
		]);
	});

	test("preserves original array", () => {
		const proposals = [
			{ id: "proposal-1", priority: "low" as const },
			{ id: "proposal-2", priority: "high" as const },
		];

		const original = [...proposals];
		sortByPriority(proposals);

		// Original array order should be preserved
		assert.deepStrictEqual(proposals, original);
	});
});

describe("sortProposals", () => {
	test("sorts by priority when field is 'priority'", () => {
		const proposals = [
			{ id: "proposal-1", priority: "low" as const },
			{ id: "proposal-2", priority: "high" as const },
			{ id: "proposal-3", priority: "medium" as const },
		];

		const sorted = sortProposals(proposals, "priority");
		expect(sorted.map((t) => t.priority)).toEqual(["high", "medium", "low"]);
	});

	test("sorts by ID when field is 'id'", () => {
		const proposals = [
			{ id: "proposal-10", priority: "high" as const },
			{ id: "proposal-2", priority: "high" as const },
			{ id: "proposal-1", priority: "high" as const },
		];

		const sorted = sortProposals(proposals, "id");
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-10",
		]);
	});

	test("handles case-insensitive field names", () => {
		const proposals = [
			{ id: "proposal-1", priority: "low" as const },
			{ id: "proposal-2", priority: "high" as const },
		];

		const sorted = sortProposals(proposals, "PRIORITY");
		expect(sorted.map((t) => t.priority)).toEqual(["high", "low"]);
	});

	test("defaults to ID sorting for unknown fields", () => {
		const proposals = [
			{ id: "proposal-10" },
			{ id: "proposal-2" },
			{ id: "proposal-1" },
		];

		const sorted = sortProposals(proposals, "unknown");
		expect(sorted.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-10",
		]);
	});

	test("defaults to ID sorting for empty field", () => {
		const proposals = [{ id: "proposal-10" }, { id: "proposal-2" }];

		const sorted = sortProposals(proposals, "");
		expect(sorted.map((t) => t.id)).toEqual(["proposal-2", "proposal-10"]);
	});
});
