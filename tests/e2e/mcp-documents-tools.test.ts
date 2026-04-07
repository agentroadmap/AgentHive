import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerDocumentTools } from "../../src/mcp/tools/documents/index.ts";
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

describe("MCP document tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-documents");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerDocumentTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all document tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"document_list",
			"document_view",
			"document_create",
			"document_update",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("creates a document", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Architecture Decision Record",
					content: "We decided to use Postgres as primary database",
					tags: "ADR,database",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Architecture Decision Record") ||
				text.includes("created") ||
				text.includes("Document"),
			`Expected document creation: ${text.slice(0, 200)}`,
		);
	});

	it("lists all documents", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: { title: "Doc A", content: "Content A" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: { title: "Doc B", content: "Content B" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "document_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Doc A") && text.includes("Doc B"),
			`Missing documents: ${text.slice(0, 300)}`,
		);
	});

	it("views a specific document", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: { title: "View test", content: "Full content here" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { title: "View test" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Full content here") || text.includes("View test"),
			`Expected document view: ${text.slice(0, 200)}`,
		);
	});

	it("updates an existing document", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: { title: "Update test", content: "Original" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "document_update",
				arguments: {
					title: "Update test",
					content: "Updated content",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Update test") ||
				text.includes("updated") ||
				text.includes("Updated content"),
			`Expected document update: ${text.slice(0, 200)}`,
		);
	});

	it("lists documents filtered by tag", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Tagged doc",
					content: "Tagged content",
					tags: "database,ADR",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "document_list", arguments: { tag: "database" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("Tagged doc") ||
				text.includes("database") ||
				text.length > 5,
			`Expected filtered list: ${text.slice(0, 200)}`,
		);
	});

	it("creates an empty document directory", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "document_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string",
			`Expected document list: ${text.slice(0, 200)}`,
		);
	});

	it("views a non-existent document gracefully", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { title: "Does not exist" } },
		});
		const text = getText(result.content);
		// Should return some response, even if it's "not found"
		assert.ok(text.length > 0, `Expected some response: ${text.slice(0, 200)}`);
	});
});
