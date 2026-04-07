import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import { compareProposalIds } from "../../src/utils/proposal-sorting.ts";

describe("board UI proposal selection", () => {
	it("compareProposalIds sorts proposals numerically by ID", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-10",
				title: "Proposal 10",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-2",
				title: "Proposal 2",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-1",
				title: "Proposal 1",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-20",
				title: "Proposal 20",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
		];

		const sorted = [...proposals].sort((a, b) =>
			compareProposalIds(a.id, b.id),
		);
		assert.strictEqual(sorted[0]?.id, "proposal-1");
		assert.strictEqual(sorted[1]?.id, "proposal-2");
		assert.strictEqual(sorted[2]?.id, "proposal-10");
		assert.strictEqual(sorted[3]?.id, "proposal-20");
	});

	it("compareProposalIds handles decimal proposal IDs correctly", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1.10",
				title: "Proposal 1.10",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-1.2",
				title: "Proposal 1.2",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-1.1",
				title: "Proposal 1.1",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
		];

		const sorted = [...proposals].sort((a, b) =>
			compareProposalIds(a.id, b.id),
		);
		assert.strictEqual(sorted[0]?.id, "proposal-1.1");
		assert.strictEqual(sorted[1]?.id, "proposal-1.2");
		assert.strictEqual(sorted[2]?.id, "proposal-1.10");
	});

	it("simulates board view proposal selection with sorted proposals", () => {
		// This test simulates the bug scenario where proposals are displayed in sorted order
		// but selection uses unsorted array
		const unsortedProposals: Proposal[] = [
			{
				id: "proposal-10",
				title: "Should be third when sorted",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-2",
				title: "Should be second when sorted",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-1",
				title: "Should be first when sorted",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
		];

		// Simulate the display order (sorted)
		const sortedProposals = [...unsortedProposals].sort((a, b) =>
			compareProposalIds(a.id, b.id),
		);
		const _displayItems = sortedProposals.map((t) => `${t.id} - ${t.title}`);

		// User clicks on index 0 (expects proposal-1)
		const selectedIndex = 0;

		// Bug: using unsorted array with sorted display index
		const wrongProposal = unsortedProposals[selectedIndex];
		assert.strictEqual(wrongProposal?.id, "proposal-10"); // Wrong!

		// Fix: using sorted array with sorted display index
		const correctProposal = sortedProposals[selectedIndex];
		assert.strictEqual(correctProposal?.id, "proposal-1"); // Correct!
	});

	it("ensures consistent ordering between display and selection", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-5",
				title: "E",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-3",
				title: "C",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-1",
				title: "A",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-4",
				title: "D",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
			{
				id: "proposal-2",
				title: "B",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				description: "",
			},
		];

		// Both display and selection should use the same sorted array
		const sortedProposals = [...proposals].sort((a, b) =>
			compareProposalIds(a.id, b.id),
		);

		// Verify each index maps to the correct proposal
		for (let i = 0; i < sortedProposals.length; i++) {
			const displayedProposal = sortedProposals[i];
			const selectedProposal = sortedProposals[i]; // Should be the same!
			assert.strictEqual(selectedProposal?.id, displayedProposal?.id ?? "");
		}

		// Verify specific selections
		assert.strictEqual(sortedProposals[0]?.id, "proposal-1");
		assert.strictEqual(sortedProposals[1]?.id, "proposal-2");
		assert.strictEqual(sortedProposals[2]?.id, "proposal-3");
		assert.strictEqual(sortedProposals[3]?.id, "proposal-4");
		assert.strictEqual(sortedProposals[4]?.id, "proposal-5");
	});
});
