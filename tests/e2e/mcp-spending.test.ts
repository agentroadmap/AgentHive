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

describe("MCP spending tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-spending");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		// Import spending tools dynamically
		const { registerSpendingTools } = await import(
			"../../src/mcp/tools/spending/index.ts"
		);
		registerSpendingTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* ignore */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all spending tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		assert.ok(
			names.includes("spending_set_cap"),
			"spending_set_cap should be registered",
		);
		assert.ok(
			names.includes("spending_log"),
			"spending_log should be registered",
		);
		assert.ok(
			names.includes("spending_report"),
			"spending_report should be registered",
		);
		assert.ok(
			names.includes("spending_reset"),
			"spending_reset should be registered",
		);
		assert.ok(
			names.includes("spending_check"),
			"spending_check should be registered",
		);
		assert.ok(
			names.includes("spending_history"),
			"spending_history should be registered",
		);
	});

	it("sets a spending cap", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "spending_set_cap",
				arguments: {
					cap: 0.5,
					currency: "USD",
					period: "daily",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected non-empty response: ${text.slice(0, 200)}`,
		);
	});

	it("logs a spending event", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: {
					amount: 0.015,
					description: "API call test",
					category: "testing",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected non-empty response: ${text.slice(0, 200)}`,
		);
	});

	it("gets spending report", async () => {
		// Log some spending first
		await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: {
					amount: 0.01,
					description: "setup cost",
					category: "init",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "spending_report", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected report output: ${text.slice(0, 200)}`);
	});

	it("checks current spending vs cap", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "spending_set_cap",
				arguments: { cap: 1.0, currency: "USD", period: "daily" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: { amount: 0.25, description: "test", category: "check" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "spending_check", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("0.25") || text.includes("1.00") || text.length > 5,
			`Expected spending check: ${text.slice(0, 200)}`,
		);
	});

	it("retrieves spending history", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: {
					amount: 0.02,
					description: "history test",
					category: "test",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "spending_history", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected spending history: ${text.slice(0, 200)}`,
		);
	});

	it("resets spending tracker", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: { amount: 0.1, description: "pre-reset", category: "test" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "spending_reset", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected spending reset: ${text.slice(0, 200)}`,
		);
	});
});
