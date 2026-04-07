import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerProtocolTools } from "../../src/mcp/tools/protocol/index.ts";
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

describe("MCP protocol tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-protocol");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerProtocolTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all protocol tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"protocol_mention_search",
			"protocol_thread_get",
			"protocol_thread_list",
			"protocol_thread_reply",
			"protocol_send_mention",
			"protocol_notifications",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("lists protocol threads", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "protocol_thread_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(text.length > 0, `Expected thread list: ${text.slice(0, 200)}`);
	});

	it("gets a specific protocol thread", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "protocol_thread_get",
				arguments: { threadId: "thread-001" },
			},
		});
		const text = getText(result.content);
		assert.ok(text.length > 0, `Expected thread: ${text.slice(0, 200)}`);
	});

	it("replies to a protocol thread", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "protocol_thread_reply",
				arguments: {
					threadId: "thread-001",
					content: "Adding my analysis to this thread",
					author: "test-agent",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected reply confirmation: ${text.slice(0, 200)}`,
		);
	});

	it("sends a protocol mention", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "protocol_send_mention",
				arguments: {
					from: "test-agent",
					to: "reviewer-agent",
					threadId: "thread-001",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected mention sent: ${text.slice(0, 200)}`);
	});

	it("searches protocol mentions", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "protocol_mention_search",
				arguments: { query: "reviewer" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected mention search: ${text.slice(0, 200)}`,
		);
	});

	it("checks protocol notifications", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "protocol_notifications",
				arguments: { userId: "test-agent" },
			},
		});
		const text = getText(result.content);
		assert.ok(text.length > 0, `Expected notifications: ${text.slice(0, 200)}`);
	});
});
