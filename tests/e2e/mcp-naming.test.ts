import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

const getText = (content: unknown[] | undefined): string => {
	const item = content?.[0] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let mcpServer: McpServer;

describe("MCP naming tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-naming");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		// Naming tools are registered in the proposal system
		const { registerNamingTools } = await import(
			"../../src/mcp/tools/naming/index.ts"
		);
		registerNamingTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers naming tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"proposal_naming_convention",
			"proposal_validate_name",
			"proposal_generate_name",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("gets naming conventions", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "proposal_naming_convention", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 10,
			`Expected naming conventions: ${text.slice(0, 200)}`,
		);
	});

	it("validates a proposal name", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_validate_name",
				arguments: { name: "P099" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected validation result: ${text.slice(0, 200)}`,
		);
	});

	it("generates a proposal name", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_generate_name",
				arguments: { topic: "database migration", type: "feature" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected generated name: ${text.slice(0, 200)}`,
		);
	});

	it("validates a name with special characters", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_validate_name",
				arguments: { name: "invalid/name" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected validation failure: ${text.slice(0, 200)}`,
		);
	});
});
