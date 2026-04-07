import { describe, test } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import { createProposalSearchIndex } from "../../src/utils/proposal-search.ts";
import { expect } from "../support/test-utils.ts";

const proposals: Proposal[] = [
	{
		id: "proposal-1",
		title: "Add auth",
		status: "Potential",
		labels: ["backend", "security"],
		assignee: [],
		createdDate: "2025-01-01",
		dependencies: [],
	},
	{
		id: "proposal-2",
		title: "Fix button",
		status: "Potential",
		labels: ["ui"],
		assignee: [],
		createdDate: "2025-01-01",
		dependencies: [],
	},
	{
		id: "proposal-3",
		title: "Docs",
		status: "Complete",
		labels: ["docs", "ui"],
		assignee: [],
		createdDate: "2025-01-01",
		dependencies: [],
	},
];

describe("createProposalSearchIndex label filtering", () => {
	test("filters proposals by single label", () => {
		const index = createProposalSearchIndex(proposals);
		const results = index.search({ labels: ["ui"] });
		expect(results.map((t) => t.id)).toEqual(["proposal-2", "proposal-3"]);
	});

	test("matches any of the selected labels", () => {
		const index = createProposalSearchIndex(proposals);
		const results = index.search({ labels: ["ui", "docs"] });
		expect(results.map((t) => t.id)).toEqual(["proposal-2", "proposal-3"]);
	});
});
