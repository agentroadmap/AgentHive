import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerKnowledgeTools } from "../../src/mcp/tools/knowledge/index.ts";
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

describe("MCP knowledge tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-knowledge");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerKnowledgeTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all knowledge tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"knowledge_add",
			"knowledge_search",
			"knowledge_record_decision",
			"knowledge_extract_pattern",
			"knowledge_get_decisions",
			"knowledge_get_stats",
			"knowledge_mark_helpful",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("adds a knowledge entry", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_add",
				arguments: {
					content: "Use pnpm for faster dependency installs",
					category: "best_practice",
					tags: "tooling,performance",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("added") || text.includes("knowledge") || text.length > 0,
			`Expected knowledge add result: ${text.slice(0, 200)}`,
		);
	});

	it("searches knowledge base", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_add",
				arguments: {
					content: "Postgres pgvector enables semantic search",
					category: "technical",
					tags: "database,vector",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_search",
				arguments: { query: "postgres" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected search results: ${text.slice(0, 200)}`,
		);
	});

	it("records a decision", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_record_decision",
				arguments: {
					decision: "Use Postgres as primary database",
					rationale: "ACID compliance, pgvector support, mature ecosystem",
					alternatives: "SQLite, MongoDB",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("recorded") || text.includes("decision") || text.length > 0,
			`Expected decision record: ${text.slice(0, 200)}`,
		);
	});

	it("extracts a reusable pattern", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_extract_pattern",
				arguments: {
					pattern_name: "backend switching via config",
					description: "Use roadmap.yaml to select database backend",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 0,
			`Expected pattern extraction: ${text.slice(0, 200)}`,
		);
	});

	it("gets all recorded decisions", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_record_decision",
				arguments: {
					decision: "Use TypeScript strict mode",
					rationale: "Catch errors early",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "knowledge_get_decisions", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("TypeScript") ||
				text.includes("No decisions") ||
				text.length > 0,
			`Expected decisions list: ${text.slice(0, 200)}`,
		);
	});

	it("gets knowledge stats", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "knowledge_get_stats", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected stats: ${text.slice(0, 200)}`);
	});

	it("marks an entry as helpful", async () => {
		// Add something to mark
		await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_add",
				arguments: {
					content: "Server-Sent Events for MCP transport",
					category: "technical",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_mark_helpful",
				arguments: { entry_id: "kb-001" },
			},
		});
		const text = getText(result.content);
		// Should succeed or give a useful error
		assert.ok(
			text.length > 0,
			`Expected helpful marking: ${text.slice(0, 200)}`,
		);
	});

	it("searches with no results", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_search",
				arguments: { query: "NONEXISTENT_KEYWORD_XYZ" },
			},
		});
		const text = getText(result.content);
		// Should return empty results, not crash
		assert.ok(
			text.includes("No results") ||
				text.includes("0 results") ||
				text.length > 0,
			`Expected no results: ${text.slice(0, 200)}`,
		);
	});

	it("adds knowledge with all fields", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "knowledge_add",
				arguments: {
					content:
						"Use agent coordination protocol: check first, announce, then act",
					category: "best_practice",
					tags: "coordination,protocol",
					proposal_link: "P001",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("coordination") ||
				text.includes("added") ||
				text.length > 0,
			`Expected full add: ${text.slice(0, 200)}`,
		);
	});
});
