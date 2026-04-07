import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import { formatProposalListItem } from "../../src/ui/board.ts";
import { getStatusStyle } from "../../src/ui/status-icon.ts";

function buildProposal(overrides: Partial<Proposal>): Proposal {
	return {
		id: "P001",
		title: "Test",
		status: "Draft",
		assignee: [],
		createdDate: "2024-01-01",
		labels: [],
		dependencies: [],
		...overrides,
	};
}

describe("Board UI Regression: Status Icons and Colors", () => {
	it("should return the correct icon and color for Draft status", () => {
		const style = getStatusStyle("Draft");
		assert.strictEqual(style.icon, "○");
		assert.strictEqual(style.color, "white");
	});

	it("should return the correct icon and color for Review status", () => {
		const style = getStatusStyle("Review");
		assert.strictEqual(style.icon, "◆");
		assert.strictEqual(style.color, "blue");
	});

	it("should return the correct icon and color for Building status", () => {
		const style = getStatusStyle("Building");
		assert.strictEqual(style.icon, "◒");
		assert.strictEqual(style.color, "yellow");
	});

	it("should return the correct icon and color for Accepted status", () => {
		const style = getStatusStyle("Accepted");
		assert.strictEqual(style.icon, "▣");
		assert.strictEqual(style.color, "cyan");
	});

	it("should return the correct icon and color for Complete status", () => {
		const style = getStatusStyle("Complete");
		assert.strictEqual(style.icon, "✅");
		assert.strictEqual(style.color, "green");
	});
});

describe("Board UI Regression: Universal Maturity Model", () => {
	it("should apply mature icon and green color for mature maturity", () => {
		const proposal = buildProposal({ maturity: "mature" as any });
		const item = formatProposalListItem(proposal);
		assert.ok(item.includes("✓"), "Should include mature icon");
		assert.ok(
			item.includes("{green-fg}"),
			"Should include green color for mature",
		);
	});

	it("should apply active icon and yellow color for active maturity", () => {
		const proposal = buildProposal({ maturity: "active" as any });
		const item = formatProposalListItem(proposal);
		assert.ok(item.includes("▶"), "Should include active icon");
		assert.ok(
			item.includes("{yellow-fg}"),
			"Should include yellow color for active",
		);
	});

	it("should apply obsolete icon and gray color for obsolete maturity", () => {
		const proposal = buildProposal({ maturity: "obsolete" as any });
		const item = formatProposalListItem(proposal);
		assert.ok(item.includes("✖"), "Should include obsolete icon");
		assert.ok(
			item.includes("{gray-fg}"),
			"Should include gray color for obsolete",
		);
	});
});

describe("Board UI Regression: Item Coloring", () => {
	it("should color the title based on the status color", () => {
		const proposal = buildProposal({
			title: "Building Component",
			status: "Building",
		});
		const item = formatProposalListItem(proposal);
		// Building status color is yellow
		assert.ok(
			item.includes("{yellow-fg}Building Component{/}"),
			"Title should be colored yellow for Building status",
		);
	});

	it("should color the title based on the status color for Accepted", () => {
		const proposal = buildProposal({
			title: "Accepted Feature",
			status: "Accepted",
		});
		const item = formatProposalListItem(proposal);
		// Accepted status color is cyan
		assert.ok(
			item.includes("{cyan-fg}Accepted Feature{/}"),
			"Title should be colored cyan for Accepted status",
		);
	});
});
