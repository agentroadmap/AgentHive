import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let mcpServer: McpServer;

async function loadConfig(server: McpServer) {
	const config = await server.filesystem.loadConfig();
	if (!config) {
		throw new Error("Failed to load roadmap configuration for tests");
	}
	return config;
}

describe("MCP final summary", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-final-summary");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await mcpServer.initializeProject("MCP Final Summary Project");

		const config = await loadConfig(mcpServer);
		registerProposalTools(mcpServer, config);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			// ignore
		}
		await safeCleanup(TEST_DIR);
	});

	it("supports finalSummary on proposal_create and proposal_view output", async () => {
		const createResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Summarized proposal",
					finalSummary: "PR-style summary",
				},
			},
		});

		const createText = getText(createResult.content);
		assert.ok(createText.includes("Proposal proposal-1 - Summarized proposal"));
		assert.ok(createText.includes("Final Summary:"));
		assert.ok(createText.includes("PR-style summary"));

		const createdProposal = await mcpServer.getProposal("proposal-1");
		assert.strictEqual(createdProposal?.finalSummary, "PR-style summary");

		const viewResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_view",
				arguments: { id: "proposal-1" },
			},
		});
		const viewText = getText(viewResult.content);
		assert.ok(viewText.includes("Final Summary:"));
		assert.ok(viewText.includes("PR-style summary"));
	});

	it("supports finalSummary set/append/clear on proposal_edit", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Editable" },
			},
		});

		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: { id: "proposal-1", finalSummary: "Initial" },
			},
		});

		let proposal = await mcpServer.getProposal("proposal-1");
		assert.strictEqual(proposal?.finalSummary, "Initial");

		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					finalSummaryAppend: ["Second", "Third"],
				},
			},
		});

		proposal = await mcpServer.getProposal("proposal-1");
		assert.strictEqual(proposal?.finalSummary, "Initial\n\nSecond\n\nThird");

		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: { id: "proposal-1", finalSummaryClear: true },
			},
		});

		proposal = await mcpServer.getProposal("proposal-1");
		assert.strictEqual(proposal?.finalSummary, undefined);
	});
});
