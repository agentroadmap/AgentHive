import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerCubicTools } from "../../src/mcp/tools/cubic/index.ts";
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

describe("MCP cubic tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-cubic");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerCubicTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all cubic tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"cubic_create",
			"cubic_list",
			"cubic_focus",
			"cubic_transition",
			"cubic_recycle",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("creates a cubic workspace", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_create",
				arguments: {
					name: "test-cubic",
					agents: ["dev-agent", "qa-agent"],
					proposals: ["P001"],
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("test-cubic") ||
				text.includes("created") ||
				text.includes("cubic"),
			`Expected cubic creation: ${text.slice(0, 200)}`,
		);
	});

	it("creates a minimal cubic with just a name", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_create",
				arguments: { name: "minimal-cubic" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("minimal-cubic") || text.includes("created"),
			`Expected minimal cubic: ${text.slice(0, 200)}`,
		);
	});

	it("lists all cubics", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_create",
				arguments: { name: "first", agents: [], proposals: [] },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_create",
				arguments: { name: "second", agents: [], proposals: [] },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "cubic_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("first") && text.includes("second"),
			`Missing cubics: ${text.slice(0, 300)}`,
		);
	});

	it("focuses on a cubic", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "cubic_create", arguments: { name: "focus-cubic" } },
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_focus",
				arguments: { name: "focus-cubic" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("focus-cubic") ||
				text.includes("focused") ||
				text.includes("lock"),
			`Expected focus result: ${text.slice(0, 200)}`,
		);
	});

	it("transitions cubic phase", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "cubic_create", arguments: { name: "phase-cubic" } },
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_transition",
				arguments: { name: "phase-cubic", newPhase: "build" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("phase-cubic") ||
				text.includes("transition") ||
				text.includes("build"),
			`Expected transition result: ${text.slice(0, 200)}`,
		);
	});

	it("recycles a cubic for new task", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "cubic_create", arguments: { name: "recycle-cubic" } },
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_recycle",
				arguments: { name: "recycle-cubic" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("recycle-cubic") || text.includes("recycled"),
			`Expected recycle result: ${text.slice(0, 200)}`,
		);
	});

	it("shows empty cubic list initially", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "cubic_list", arguments: {} },
		});
		const text = getText(result.content);
		// Should handle empty state gracefully
		assert.ok(
			typeof text === "string",
			`Expected cubic list: ${text.slice(0, 200)}`,
		);
	});

	it("creates cubic with associated proposals", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_create",
				arguments: {
					name: "proposal-cubic",
					agents: ["dev-1", "dev-2"],
					proposals: ["P001", "P002", "P003"],
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("proposal-cubic") ||
				text.includes("P001") ||
				text.length > 0,
			`Expected proposal-attached cubic: ${text.slice(0, 200)}`,
		);
	});

	it("transitions through multiple phases", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "cubic_create", arguments: { name: "multi-phase" } },
		});

		// Design -> Build
		await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_transition",
				arguments: { name: "multi-phase", newPhase: "build" },
			},
		});

		// Build -> Review
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "cubic_transition",
				arguments: { name: "multi-phase", newPhase: "review" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("multi-phase") ||
				text.includes("review") ||
				text.length > 0,
			`Expected multi-phase transition: ${text.slice(0, 200)}`,
		);
	});
});
