import assert from "node:assert";
import { describe, test } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import {
	collectAvailableLabels,
	formatLabelSummary,
	labelsToLower,
} from "../../src/utils/label-filter.ts";
import { expect } from "../support/test-utils.ts";

describe("label filter utilities", () => {
	test("collectAvailableLabels merges configured labels and proposal labels without duplicates", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "One",
				status: "Potential",
				labels: ["bug", "UI"],
				assignee: [],
				createdDate: "2025-01-01",
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "Two",
				status: "Potential",
				labels: ["infra", "bug"],
				assignee: [],
				createdDate: "2025-01-01",
				dependencies: [],
			},
		];
		const configured = ["backend", "bug"];

		const labels = collectAvailableLabels(proposals, configured);

		assert.deepStrictEqual(labels, ["backend", "bug", "UI", "infra"]);
	});

	test("formatLabelSummary produces concise summaries", () => {
		expect(formatLabelSummary([])).toBe("Labels: All");
		expect(formatLabelSummary(["bug"])).toBe("Labels: bug");
		expect(formatLabelSummary(["bug", "ui"])).toBe("Labels: bug, ui");
		expect(formatLabelSummary(["bug", "ui", "infra"])).toBe(
			"Labels: bug, ui +1",
		);
	});

	test("labelsToLower normalizes labels for filtering", () => {
		expect(labelsToLower([" Bug ", "UI"])).toEqual(["bug", "ui"]);
	});
});
