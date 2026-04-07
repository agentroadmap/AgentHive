import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerDocumentTools } from "../../src/mcp/tools/documents/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

// Helper to extract text from MCP content (handles union types)
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

describe("MCP document tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-documents");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await mcpServer.initializeProject("Docs Project");
		const config = await loadConfig(mcpServer);
		registerDocumentTools(mcpServer, config);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			// ignore shutdown issues in tests
		}
		await safeCleanup(TEST_DIR);
	});

	it("creates and lists documents", async () => {
		const createResult = await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Engineering Guidelines",
					content: "# Overview\n\nFollow the documented practices.",
				},
			},
		});

		const createText = getText(createResult.content);
		assert.ok(createText.includes("Document created successfully."));
		assert.ok(createText.includes("Document doc-1 - Engineering Guidelines"));
		assert.ok(createText.includes("# Overview"));

		const listResult = await mcpServer.testInterface.callTool({
			params: { name: "document_list", arguments: {} },
		});

		const listText = getText(listResult.content);
		assert.ok(listText.includes("Documents:"));
		assert.ok(listText.includes("doc-1 - Engineering Guidelines"));
		assert.ok(listText.includes("tags: (none)"));
	});

	it("filters documents using substring search", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Engineering Guidelines",
					content: "Content",
				},
			},
		});

		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Product Strategy",
					content: "Strategy content",
				},
			},
		});

		const filteredResult = await mcpServer.testInterface.callTool({
			params: { name: "document_list", arguments: { search: "strat" } },
		});

		const filteredText = getText(filteredResult.content);
		assert.ok(filteredText.includes("Documents:"));
		assert.ok(filteredText.includes("Product Strategy"));
		assert.ok(!filteredText.includes("Engineering Guidelines"));
	});

	it("views documents regardless of ID casing or padding", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Runbook",
					content: "Step 1: Do the thing.",
				},
			},
		});

		const withPrefix = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { id: "doc-1" } },
		});
		const withoutPrefix = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { id: "1" } },
		});
		const uppercase = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { id: "DOC-0001" } },
		});
		const zeroPadded = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { id: "0001" } },
		});

		const prefixText = getText(withPrefix.content);
		const noPrefixText = getText(withoutPrefix.content);
		const uppercaseText = getText(uppercase.content);
		const zeroPaddedText = getText(zeroPadded.content);
		assert.ok(prefixText.includes("Document doc-1 - Runbook"));
		assert.ok(prefixText.includes("Step 1: Do the thing."));
		assert.ok(noPrefixText.includes("Document doc-1 - Runbook"));
		assert.ok(uppercaseText.includes("Document doc-1 - Runbook"));
		assert.ok(zeroPaddedText.includes("Document doc-1 - Runbook"));
	});

	it("updates documents including title changes", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Incident Response",
					content: "Initial content",
				},
			},
		});

		const updateResult = await mcpServer.testInterface.callTool({
			params: {
				name: "document_update",
				arguments: {
					id: "DOC-0001",
					title: "Incident Response Handbook",
					content: "Updated procedures",
				},
			},
		});

		const updateText = getText(updateResult.content);
		assert.ok(updateText.includes("Document updated successfully."));
		assert.ok(
			updateText.includes("Document doc-1 - Incident Response Handbook"),
		);
		assert.ok(updateText.includes("Updated procedures"));

		const viewResult = await mcpServer.testInterface.callTool({
			params: { name: "document_view", arguments: { id: "doc-1" } },
		});
		const viewText = getText(viewResult.content);
		assert.ok(viewText.includes("Incident Response Handbook"));
		assert.ok(viewText.includes("Updated procedures"));
	});

	it("searches documents and includes formatted scores", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "document_create",
				arguments: {
					title: "Architecture Overview",
					content: "Contains service topology details.",
				},
			},
		});

		const searchResult = await mcpServer.testInterface.callTool({
			params: {
				name: "document_search",
				arguments: {
					query: "architecture",
				},
			},
		});

		const searchText = getText(searchResult.content);
		assert.ok(searchText.includes("Documents:"));
		assert.ok(/Architecture Overview/.test(searchText));
		assert.ok(/\[score [0-1]\.\d{3}]/.test(searchText));
	});
});
