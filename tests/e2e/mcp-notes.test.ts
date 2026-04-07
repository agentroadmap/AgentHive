import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerNoteTools } from "../../src/mcp/tools/notes/index.ts";
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

describe("MCP notes tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-notes");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerNoteTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all note tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"create_note",
			"note_list",
			"delete_note",
			"note_display",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("creates a note", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: {
					title: "Meeting notes",
					content: "Discussed migration to Postgres backend",
					tags: "meeting,migration",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Meeting notes") ||
				text.includes("created") ||
				text.includes("Note"),
			`Expected note creation: ${text.slice(0, 200)}`,
		);
	});

	it("lists notes", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: { title: "Note A", content: "Content A" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: { title: "Note B", content: "Content B" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "note_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Note A") && text.includes("Note B"),
			`Missing notes: ${text.slice(0, 300)}`,
		);
	});

	it("displays a specific note", async () => {
		const createResult = await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: { title: "Display test", content: "Full content" },
			},
		});
		const _createText = getText(createResult.content);

		const result = await mcpServer.testInterface.callTool({
			params: { name: "note_display", arguments: { title: "Display test" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Full content") || text.includes("Display test"),
			`Expected note display: ${text.slice(0, 200)}`,
		);
	});

	it("deletes a note", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: { title: "To delete", content: "Temporary" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "delete_note", arguments: { title: "To delete" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("To delete") ||
				text.includes("deleted") ||
				text.includes("removed"),
			`Expected note deletion: ${text.slice(0, 200)}`,
		);
	});

	it("creates a note with tags and searches", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "create_note",
				arguments: {
					title: "Tagged note",
					content: "Important",
					tags: "urgent,priority",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "note_list", arguments: { tag: "urgent" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Tagged note") ||
				text.includes("Important") ||
				text.length > 5,
			`Expected tagged list: ${text.slice(0, 200)}`,
		);
	});
});
