import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerMessageTools } from "../../src/mcp/tools/messages/index.ts";
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

describe("MCP messaging tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-messages");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await mcpServer.initializeProject("Test Project");

		registerMessageTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* ignore */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all messaging tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		assert.ok(names.includes("chan_list"), "chan_list should be registered");
		assert.ok(names.includes("msg_read"), "msg_read should be registered");
		assert.ok(names.includes("msg_send"), "msg_send should be registered");
		assert.ok(
			names.includes("chan_subscribe"),
			"chan_subscribe should be registered",
		);
	});

	it("lists channels (empty)", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "chan_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("No message channels") ||
				text.includes("Available Channels"),
		);
	});

	it("sends a message to a group channel", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "msg_send",
				arguments: {
					from: "test-agent",
					message: "Hello team",
					channel: "project",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Message sent"));
		assert.ok(text.includes("#project"));
	});

	it("sends a message to the public channel", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "msg_send",
				arguments: {
					from: "test-agent",
					message: "Hello all",
					channel: "public",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Message sent"));
		assert.ok(text.includes("#public"));
	});

	it("sends a private DM", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "msg_send",
				arguments: { from: "test-agent", message: "Hey you", to: "bob" },
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Message sent"));
		assert.ok(text.includes("@bob"));
	});

	it("sends a message with negotiation intent", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "msg_send",
				arguments: {
					from: "test-agent",
					message: "Requesting this proposal",
					channel: "project",
					intent: {
						type: "claim_request",
						proposalId: "proposal-1",
						reason: "Testing",
					},
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Message sent"));
		assert.ok(text.includes("claim_request"));
	});

	it("reads messages from a channel", async () => {
		// First send a message
		await mcpServer.testInterface.callTool({
			params: {
				name: "msg_send",
				arguments: {
					from: "test-agent",
					message: "Test message",
					channel: "project",
				},
			},
		});

		// Then read it back
		const result = await mcpServer.testInterface.callTool({
			params: { name: "msg_read", arguments: { channel: "project" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("project") || text.includes("Test message"),
			`Expected messages, got: ${text}`,
		);
	});

	it("reads empty channel", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "msg_read", arguments: { channel: "nonexistent" } },
		});
		const text = getText(result.content);
		assert.ok(text.includes("No messages"));
	});

	it("subscribes to a channel", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "chan_subscribe",
				arguments: { channel: "project", from: "test-agent", subscribe: true },
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Subscribed"));
		assert.ok(text.includes("test-agent"));
		assert.ok(text.includes("project"));
	});

	it("unsubscribes from a channel", async () => {
		// Subscribe first
		await mcpServer.testInterface.callTool({
			params: {
				name: "chan_subscribe",
				arguments: { channel: "project", from: "test-agent" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "chan_subscribe",
				arguments: { channel: "project", from: "test-agent", subscribe: false },
			},
		});
		const text = getText(result.content);
		assert.ok(text.includes("Unsubscribed"));
	});
});
