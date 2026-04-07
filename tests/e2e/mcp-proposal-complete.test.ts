import assert from "node:assert";
import { globSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let server: McpServer;

async function loadConfigOrThrow(mcpServer: McpServer) {
	const config = await mcpServer.filesystem.loadConfig();
	if (!config) {
		throw new Error("Failed to load config");
	}
	return config;
}

describe("MCP proposal_complete", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-proposal-complete");
		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await server.initializeProject("Test Project");

		const config = await loadConfigOrThrow(server);
		registerProposalTools(server, config);
	});

	afterEach(async () => {
		try {
			await server.stop();
		} catch {
			// ignore
		}
		await safeCleanup(TEST_DIR);
	});

	it("moves Complete proposals to the completed folder", async () => {
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Complete proposal",
					status: "Complete",
				},
			},
		});

		const archiveAttempt = await server.testInterface.callTool({
			params: {
				name: "proposal_archive",
				arguments: { id: "proposal-1" },
			},
		});
		assert.strictEqual(archiveAttempt.isError, true);
		expect(getText(archiveAttempt.content)).toContain("proposal_complete");

		const complete = await server.testInterface.callTool({
			params: {
				name: "proposal_complete",
				arguments: { id: "proposal-1" },
			},
		});
		assert.strictEqual(complete.isError, undefined);
		expect(getText(complete.content)).toContain(
			"Completed proposal proposal-1",
		);

		const activeProposal = await server.filesystem.loadProposal("proposal-1");
		assert.strictEqual(activeProposal, null);

		const completedFiles = await Array.fromAsync(
			(globSync as any)("proposal-1*.md", {
				cwd: server.filesystem.completedDir,
				follow: true,
			}),
		);
		assert.strictEqual(completedFiles.length, 1);
	});

	it("refuses to complete proposals that are not Complete", async () => {
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Not complete proposal",
					status: "Potential",
				},
			},
		});

		const complete = await server.testInterface.callTool({
			params: {
				name: "proposal_complete",
				arguments: { id: "proposal-1" },
			},
		});
		assert.strictEqual(complete.isError, true);
		expect(getText(complete.content)).toContain("not Complete");
	});
});
