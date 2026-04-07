import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

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

describe("MCP proposal references and documentation", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-refs-docs");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await mcpServer.initializeProject("Test Project");

		const config = await loadConfig(mcpServer);
		registerProposalTools(mcpServer, config);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			// ignore
		}
		await safeCleanup(TEST_DIR);
	});

	describe("proposal_create with references", () => {
		it("creates proposal with references", async () => {
			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Feature with refs",
						references: ["https://github.com/issue/123", "src/api.ts"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Proposal proposal-1 - Feature with refs"));
			assert.ok(
				text.includes("References: https://github.com/issue/123, src/api.ts"),
			);
		});

		it("creates proposal without references", async () => {
			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Feature without refs",
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Proposal proposal-1 - Feature without refs"));
			assert.ok(!text.includes("References:"));
		});
	});

	describe("proposal_create with documentation", () => {
		it("creates proposal with documentation", async () => {
			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Feature with docs",
						documentation: ["https://design-docs.example.com", "docs/spec.md"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Proposal proposal-1 - Feature with docs"));
			assert.ok(
				text.includes(
					"Documentation: https://design-docs.example.com, docs/spec.md",
				),
			);
		});

		it("creates proposal without documentation", async () => {
			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Feature without docs",
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Proposal proposal-1 - Feature without docs"));
			assert.ok(!text.includes("Documentation:"));
		});
	});

	describe("proposal_create with both references and documentation", () => {
		it("creates proposal with both fields", async () => {
			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Feature with both",
						references: ["https://github.com/issue/123"],
						documentation: ["https://design-docs.example.com"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Proposal proposal-1 - Feature with both"));
			assert.ok(text.includes("References: https://github.com/issue/123"));
			assert.ok(
				text.includes("Documentation: https://design-docs.example.com"),
			);
		});
	});

	describe("proposal_edit with references", () => {
		it("sets references on existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: { title: "Proposal to edit" },
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						references: ["https://example.com", "file.ts"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("References: https://example.com, file.ts"));
		});

		it("adds references to existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Proposal with refs",
						references: ["file1.ts"],
					},
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						addReferences: ["file2.ts", "file3.ts"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("References: file1.ts, file2.ts, file3.ts"));
		});

		it("removes references from existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Proposal with refs",
						references: ["file1.ts", "file2.ts", "file3.ts"],
					},
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						removeReferences: ["file2.ts"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("References: file1.ts, file3.ts"));
			assert.ok(!text.includes("file2.ts"));
		});
	});

	describe("proposal_edit with documentation", () => {
		it("sets documentation on existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: { title: "Proposal to edit" },
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						documentation: ["https://docs.example.com", "README.md"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(
				text.includes("Documentation: https://docs.example.com, README.md"),
			);
		});

		it("adds documentation to existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Proposal with docs",
						documentation: ["doc1.md"],
					},
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						addDocumentation: ["doc2.md", "doc3.md"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Documentation: doc1.md, doc2.md, doc3.md"));
		});

		it("removes documentation from existing proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Proposal with docs",
						documentation: ["doc1.md", "doc2.md", "doc3.md"],
					},
				},
			});

			const result = await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_edit",
					arguments: {
						id: "proposal-1",
						removeDocumentation: ["doc2.md"],
					},
				},
			});

			const text = getText(result.content);
			assert.ok(text.includes("Documentation: doc1.md, doc3.md"));
			assert.ok(!text.includes("doc2.md"));
		});
	});

	describe("persistence verification", () => {
		it("persists references and documentation in proposal", async () => {
			await mcpServer.testInterface.callTool({
				params: {
					name: "proposal_create",
					arguments: {
						title: "Persistent proposal",
						references: ["ref1.ts", "ref2.ts"],
						documentation: ["doc1.md", "doc2.md"],
					},
				},
			});

			// Reload proposal to verify persistence
			const proposal = await mcpServer.getProposal("proposal-1");
			assert.deepStrictEqual(proposal?.references, ["ref1.ts", "ref2.ts"]);
			assert.deepStrictEqual(proposal?.documentation, ["doc1.md", "doc2.md"]);
		});
	});
});
