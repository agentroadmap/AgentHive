import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
	MCP_STATE_CREATION_GUIDE,
	MCP_STATE_EXECUTION_GUIDE,
	MCP_STATE_FINALIZATION_GUIDE,
	MCP_WORKFLOW_OVERVIEW,
	MCP_WORKFLOW_OVERVIEW_TOOLS,
} from "../../src/guidelines/mcp/index.ts";
import { registerWorkflowResources } from "../../src/mcp/resources/workflow/index.ts";
import { createMcpServer, McpServer } from "../../src/mcp/server.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import { registerWorkflowTools } from "../../src/mcp/tools/workflow/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

// Helpers to extract text from MCP responses (handles union types)
const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};
const getContentsText = (
	contents: unknown[] | undefined,
	index = 0,
): string => {
	const item = contents?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;

async function bootstrapServer(): Promise<McpServer> {
	TEST_DIR = createUniqueTestDir("mcp-server");
	// Use normal mode instructions for bootstrapped test server
	const server = new McpServer(TEST_DIR, "Test instructions");

	await server.filesystem.ensureRoadmapStructure();
	execSync(`git init -b main`, { cwd: TEST_DIR });
	execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
	execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

	await server.initializeProject("Test Project");

	// Register workflow resources and tools manually (normally complete in createMcpServer)
	registerWorkflowResources(server);
	registerWorkflowTools(server);

	return server;
}

describe("McpServer bootstrap", () => {
	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("exposes core capabilities before registration", async () => {
		const server = await bootstrapServer();

		const tools = await server.testInterface.listTools();
		expect(tools.tools.map((tool) => tool.name)).toEqual([
			"get_workflow_overview",
			"get_proposal_creation_guide",
			"get_proposal_execution_guide",
			"get_proposal_finalization_guide",
			"get_chat_skill",
		]);

		const resources = await server.testInterface.listResources();
		expect(resources.resources.map((r) => r.uri)).toEqual([
			"roadmap://workflow/overview",
			"roadmap://workflow/proposal-creation",
			"roadmap://workflow/proposal-execution",
			"roadmap://workflow/proposal-finalization",
			"roadmap://skills/chat",
		]);

		const prompts = await server.testInterface.listPrompts();
		assert.deepStrictEqual(prompts.prompts, []);

		const resourceTemplates =
			await server.testInterface.listResourceTemplates();
		assert.deepStrictEqual(resourceTemplates.resourceTemplates, []);

		await server.stop();
	});

	it("workflow overview resource returns correct content", async () => {
		const server = await bootstrapServer();

		const result = await server.testInterface.readResource({
			params: { uri: "roadmap://workflow/overview" },
		});

		assert.strictEqual(result.contents.length, 1);
		expect(getContentsText(result.contents)).toBe(MCP_WORKFLOW_OVERVIEW);
		assert.strictEqual(result.contents[0]?.mimeType, "text/markdown");

		await server.stop();
	});

	it("proposal creation guide resource returns correct content", async () => {
		const server = await bootstrapServer();

		const result = await server.testInterface.readResource({
			params: { uri: "roadmap://workflow/proposal-creation" },
		});

		assert.strictEqual(result.contents.length, 1);
		expect(getContentsText(result.contents)).toBe(MCP_STATE_CREATION_GUIDE);

		await server.stop();
	});

	it("proposal execution guide resource returns correct content", async () => {
		const server = await bootstrapServer();

		const result = await server.testInterface.readResource({
			params: { uri: "roadmap://workflow/proposal-execution" },
		});

		assert.strictEqual(result.contents.length, 1);
		expect(getContentsText(result.contents)).toBe(MCP_STATE_EXECUTION_GUIDE);

		await server.stop();
	});

	it("proposal finalization guide resource returns correct content", async () => {
		const server = await bootstrapServer();

		const result = await server.testInterface.readResource({
			params: { uri: "roadmap://workflow/proposal-finalization" },
		});

		assert.strictEqual(result.contents.length, 1);
		expect(getContentsText(result.contents)).toBe(MCP_STATE_FINALIZATION_GUIDE);

		await server.stop();
	});

	it("workflow tools mirror resource content", async () => {
		const server = await bootstrapServer();

		const overview = await server.testInterface.callTool({
			params: { name: "get_workflow_overview", arguments: {} },
		});
		expect(getText(overview.content)).toBe(MCP_WORKFLOW_OVERVIEW_TOOLS);

		const creation = await server.testInterface.callTool({
			params: { name: "get_proposal_creation_guide", arguments: {} },
		});
		expect(getText(creation.content)).toBe(MCP_STATE_CREATION_GUIDE);

		await server.stop();
	});

	it("registers proposal tools via helpers", async () => {
		const server = await bootstrapServer();
		const config = await server.filesystem.loadConfig();
		if (!config) {
			throw new Error("Failed to load config");
		}

		registerProposalTools(server, config);

		const tools = await server.testInterface.listTools();
		const toolNames = tools.tools.map((tool) => tool.name).sort();
		assert.deepStrictEqual(toolNames, [
			"get_chat_skill",
			"get_proposal_creation_guide",
			"get_proposal_execution_guide",
			"get_proposal_finalization_guide",
			"get_workflow_overview",
			"proposal_archive",
			"proposal_claim",
			"proposal_complete",
			"proposal_create",
			"proposal_demote",
			"proposal_edit",
			"proposal_export",
			"proposal_heartbeat",
			"proposal_impact",
			"proposal_list",
			"proposal_list_metadata",
			"proposal_merge",
			"proposal_move",
			"proposal_pickup",
			"proposal_priority_down",
			"proposal_priority_up",
			"proposal_promote",
			"proposal_prune_claims",
			"proposal_release",
			"proposal_renew",
			"proposal_request_enrich",
			"proposal_search",
			"proposal_view",
		]);

		const resources = await server.testInterface.listResources();
		expect(resources.resources.map((r) => r.uri)).toEqual([
			"roadmap://workflow/overview",
			"roadmap://workflow/proposal-creation",
			"roadmap://workflow/proposal-execution",
			"roadmap://workflow/proposal-finalization",
			"roadmap://skills/chat",
		]);
		assert.ok(MCP_WORKFLOW_OVERVIEW.includes("## AgentHive Overview (MCP)"));

		const resourceTemplates =
			await server.testInterface.listResourceTemplates();
		assert.deepStrictEqual(resourceTemplates.resourceTemplates, []);

		await server.stop();
	});

	it("createMcpServer wires stdio-ready instance", async () => {
		TEST_DIR = createUniqueTestDir("mcp-server-factory");

		const bootstrap = new McpServer(TEST_DIR, "Bootstrap instructions");
		await bootstrap.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await bootstrap.initializeProject("Factory Project");
		await bootstrap.stop();

		const server = await createMcpServer(TEST_DIR);

		const tools = await server.testInterface.listTools();
		const toolNames = tools.tools.map((tool) => tool.name);
		for (const expected of [
			"get_workflow_overview",
			"get_proposal_creation_guide",
			"get_proposal_execution_guide",
			"get_proposal_finalization_guide",
			"get_chat_skill",
			"proposal_create",
			"proposal_list",
			"proposal_search",
			"proposal_edit",
			"proposal_view",
			"proposal_claim",
			"directive_list",
			"document_list",
			"document_view",
			"document_create",
			"document_update",
			"document_search",
			"chan_list",
			"msg_read",
			"msg_send",
			"cubic_create",
			"agent_register",
			"agent_list",
			"team_create",
			"test_run",
		]) {
			assert.ok(
				toolNames.includes(expected),
				`Expected tool list to include ${expected}`,
			);
		}

		const resources = await server.testInterface.listResources();
		expect(resources.resources.map((r) => r.uri)).toEqual([
			"roadmap://workflow/overview",
			"roadmap://workflow/proposal-creation",
			"roadmap://workflow/proposal-execution",
			"roadmap://workflow/proposal-finalization",
			"roadmap://skills/chat",
		]);
		assert.ok(MCP_WORKFLOW_OVERVIEW.includes("## AgentHive Overview (MCP)"));

		const resourceTemplates =
			await server.testInterface.listResourceTemplates();
		assert.deepStrictEqual(resourceTemplates.resourceTemplates, []);

		await server.connect();
		await server.start();
		await server.stop();
		await safeCleanup(TEST_DIR);
	});
});
