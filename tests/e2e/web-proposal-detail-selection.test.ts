import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import {
	mergeProposalDetailState,
	getProposalSelectionAliases,
	proposalMatchesSelection,
} from "../../src/web/lib/proposal-detail-selection.ts";

type ProposalWithSelectionAliases = Proposal & {
	selectionAliases?: string[];
	displayId?: string;
	websocketId?: string;
};

function createProposal(
	overrides: Partial<ProposalWithSelectionAliases> = {},
): ProposalWithSelectionAliases {
	return {
		id: "P123",
		title: "Proposal 123",
		status: "DRAFT",
		assignee: [],
		createdDate: "2026-04-25T00:00:00Z",
		labels: [],
		dependencies: [],
		...overrides,
	};
}

describe("Web proposal detail selection", () => {
	it("matches the same proposal across display-id and websocket-id refreshes", () => {
		const selected = createProposal({
			id: "P123",
			displayId: "P123",
			websocketId: "123",
			selectionAliases: ["P123", "123"],
		});
		const refreshed = createProposal({
			id: "123",
			displayId: "P123",
			websocketId: "123",
			selectionAliases: ["P123", "123"],
		});

		assert.deepStrictEqual(getProposalSelectionAliases(selected), ["P123", "123"]);
		assert.strictEqual(proposalMatchesSelection(refreshed, selected), true);
	});

	it("preserves acceptance criteria when a live refresh is missing them", () => {
		const selected = createProposal({
			acceptanceCriteriaItems: [
				{ index: 1, text: "First AC", checked: false },
				{ index: 2, text: "Second AC", checked: true },
				{ index: 3, text: "Third AC", checked: false },
			],
			summary: "Full proposal body",
			displayId: "P123",
			websocketId: "123",
			selectionAliases: ["P123", "123"],
		});
		const sparseRefresh = createProposal({
			id: "123",
			displayId: "P123",
			websocketId: "123",
			summary: "",
			acceptanceCriteriaItems: [],
			selectionAliases: ["P123", "123"],
		});

		const merged = mergeProposalDetailState(selected, sparseRefresh);

		assert.strictEqual(merged.summary, "Full proposal body");
		assert.strictEqual(merged.acceptanceCriteriaItems?.length, 3);
		assert.strictEqual(merged.acceptanceCriteriaItems?.[2]?.text, "Third AC");
	});
});
