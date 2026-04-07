import assert from "node:assert";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
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

describe("MCP draft support via proposal tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-drafts");
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

	it("creates, lists, and views drafts while excluding them by default", async () => {
		const createResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Draft proposal",
					status: "Draft",
				},
			},
		});

		expect(getText(createResult.content)).toContain(
			"Proposal draft-1 - Draft proposal",
		);

		const draft = await mcpServer.filesystem.loadDraft("draft-1");
		assert.notStrictEqual(draft, null);

		const listDefault = await mcpServer.testInterface.callTool({
			params: { name: "proposal_list", arguments: {} },
		});

		const defaultText = getText(listDefault.content);
		assert.ok(!defaultText.includes("draft-1"));

		const listDrafts = await mcpServer.testInterface.callTool({
			params: { name: "proposal_list", arguments: { status: "Draft" } },
		});

		const listDraftText = getText(listDrafts.content);
		assert.ok(listDraftText.includes("Draft:"));
		assert.ok(listDraftText.includes("draft-1 - Draft proposal"));

		const viewDraft = await mcpServer.testInterface.callTool({
			params: { name: "proposal_view", arguments: { id: "draft-1" } },
		});

		const viewText = getText(viewDraft.content);
		assert.ok(viewText.includes("Proposal draft-1 - Draft proposal"));
	});

	it("promotes and demotes via proposal_edit status changes", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Promotion candidate",
					status: "Draft",
				},
			},
		});

		const promoteResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "draft-1",
					status: "Review",
					title: "Promoted proposal",
				},
			},
		});

		console.log("PROMOTE_TEXT:", getText(promoteResult.content));
		expect(getText(promoteResult.content)).toContain(
			"Proposal PROPOSAL-1 - Promoted proposal",
		);

		const promoted = await mcpServer.getProposal("proposal-1");
		assert.strictEqual(promoted?.status, "Review");
		const allProposals = await mcpServer.filesystem.listProposals();
		console.log(
			"PROPOSALS AFTER PROMOTION:",
			allProposals.map((p) => `${p.id}:${p.title}`),
		);

		const removedDraft = await mcpServer.filesystem.loadDraft("draft-1");
		assert.strictEqual(removedDraft, null);

		const demoteResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					status: "Draft",
					title: "Demoted draft",
				},
			},
		});

		const demoteText = getText(demoteResult.content);
		console.log("DEMOTE_TEXT:", demoteText);
		const match = demoteText.match(/Proposal (draft-\d+)/);
		assert.notStrictEqual(match, null);
		const draftId = match?.[1] ?? "";

		const demotedDraft = await mcpServer.filesystem.loadDraft(draftId);
		assert.strictEqual(demotedDraft?.status, "Draft");
		assert.strictEqual(demotedDraft?.title, "Demoted draft");

		const proposalFile = await mcpServer.filesystem.loadProposal("proposal-1");
		assert.strictEqual(proposalFile, null);
	});

	it("searches and archives drafts when requested", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Archive this draft",
					status: "Draft",
				},
			},
		});

		const searchResult = await mcpServer.testInterface.callTool({
			params: {
				name: "proposal_search",
				arguments: {
					query: "Archive",
					status: "Draft",
				},
			},
		});

		const searchText = getText(searchResult.content);
		assert.ok(searchText.includes("draft-1 - Archive this draft"));

		await mcpServer.testInterface.callTool({
			params: { name: "proposal_archive", arguments: { id: "draft-1" } },
		});

		const archivedDraft = await mcpServer.filesystem.loadDraft("draft-1");
		assert.strictEqual(archivedDraft, null);

		const archiveDir = join(TEST_DIR, "roadmap", "archive", "drafts");
		const archiveFiles = await readdir(archiveDir);
		expect(archiveFiles.some((file) => file.startsWith("draft-1"))).toBe(true);
	});
});
