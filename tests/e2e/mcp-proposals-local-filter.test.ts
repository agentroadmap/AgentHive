import assert from "node:assert";
import { describe, it } from "node:test";
import type { McpServer } from "../../src/mcp/server.ts";
import { ProposalHandlers } from "../../src/mcp/tools/proposals/handlers.ts";
import type { Proposal } from "../../src/types/index.ts";

const localProposal: Proposal = {
	id: "proposal-1",
	title: "Local proposal",
	status: "Potential",
	assignee: ["gemini@local"],
	createdDate: "2025-12-03",
	labels: [],
	dependencies: [],
	origin: "local",
};

const remoteProposal: Proposal = {
	id: "proposal-2",
	title: "Remote proposal",
	status: "Potential",
	assignee: ["copilot@local"],
	createdDate: "2025-12-03",
	labels: [],
	dependencies: [],
	origin: "remote",
};

describe("MCP proposal tools local filtering", () => {
	const mockConfig = {
		statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
	};

	it("filters cross-branch proposals out of proposal_list", async () => {
		const handlers = new ProposalHandlers({
			queryProposals: async () => [localProposal, remoteProposal],
			filesystem: {
				loadConfig: async () => mockConfig,
			},
		} as unknown as McpServer);

		const result = await handlers.listProposals({});
		const text = (result.content ?? [])
			.map((c) => (typeof c === "object" && c && "text" in c ? c.text : ""))
			.join("\n");

		assert.ok(text.includes("proposal-1 - Local proposal"));
		assert.ok(!text.includes("proposal-2 - Remote proposal"));
	});

	it("filters cross-branch proposals out of proposal_search", async () => {
		const handlers = new ProposalHandlers({
			loadProposals: async () => [localProposal, remoteProposal],
			filesystem: {
				loadConfig: async () => mockConfig,
			},
		} as unknown as McpServer);

		const result = await handlers.searchProposals({ query: "proposal" });
		const text = (result.content ?? [])
			.map((c) => (typeof c === "object" && c && "text" in c ? c.text : ""))
			.join("\n");

		assert.ok(text.includes("proposal-1 - Local proposal"));
		assert.ok(!text.includes("proposal-2 - Remote proposal"));
	});

	it("supports filtering by assignee in proposal_list", async () => {
		const handlers = new ProposalHandlers({
			queryProposals: async (options: any) => {
				let results = [localProposal, remoteProposal];
				if (options.filters?.assignee) {
					results = results.filter((s) =>
						s.assignee.includes(options.filters.assignee),
					);
				}
				return results;
			},
			filesystem: {
				loadConfig: async () => mockConfig,
			},
		} as unknown as McpServer);

		const result = await handlers.listProposals({ assignee: "gemini@local" });
		const text = (result.content ?? [])
			.map((c) => (typeof c === "object" && c && "text" in c ? c.text : ""))
			.join("\n");

		assert.ok(text.includes("proposal-1 - Local proposal"));
		assert.ok(!text.includes("proposal-copilot")); // remote proposal has copilot@local
		assert.ok(!text.includes("proposal-2 - Remote proposal"));
	});
});
