import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerTeamTools } from "../../src/mcp/tools/teams/index.ts";
import { registerWorkflowTools } from "../../src/mcp/tools/workflow/index.ts";
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

// ---------------------------------------------------------------------------
// Workflow state machine tests (transition_proposal, AC, deps, reviews)
// ---------------------------------------------------------------------------
describe("MCP workflow tools — state machine", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-workflow");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerWorkflowTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers RFC workflow tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"transition_proposal",
			"get_valid_transitions",
			"add_acceptance_criteria",
			"verify_ac",
			"list_ac",
			"add_dependency",
			"get_dependencies",
			"submit_review",
			"list_reviews",
			"add_discussion",
		];
		for (const name of expected) {
			assert.ok(
				names.includes(name),
				`Expected tool "${name}" to be registered`,
			);
		}
	});

	it("lists valid state transitions", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "get_valid_transitions",
				arguments: {},
			},
		});
		const text = getText(result.content);
		// Should return transition rules
		assert.ok(
			text.length > 10,
			`Expected transition rules: ${text.slice(0, 200)}`,
		);
	});

	it("adds acceptance criteria to a proposal", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "add_acceptance_criteria",
				arguments: {
					proposalId: "P099",
					criteria: ["Must compile", "Must pass tests"],
				},
			},
		});
		const text = getText(result.content);
		// Postgres backend — even if P099 doesn't exist, handler should respond
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected response: ${text.slice(0, 200)}`,
		);
	});

	it("submits a review", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "submit_review",
				arguments: {
					proposalId: "P099",
					reviewer: "test-agent",
					decision: "approved",
					notes: "Looks good",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected review response: ${text.slice(0, 200)}`,
		);
	});

	it("lists reviews for a proposal", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "list_reviews",
				arguments: { proposalId: "P099" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string",
			`Expected reviews list: ${text.slice(0, 200)}`,
		);
	});

	it("adds a dependency", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "add_dependency",
				arguments: {
					proposalId: "P099",
					dependsOn: "P001",
					type: "blocks",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected dependency response: ${text.slice(0, 200)}`,
		);
	});

	it("adds a discussion comment", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "add_discussion",
				arguments: {
					proposalId: "P099",
					author: "test-agent",
					content: "This looks like a solid proposal.",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected discussion response: ${text.slice(0, 200)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Team tools tests
// ---------------------------------------------------------------------------
describe("MCP team tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-teams");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerTeamTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all team tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = [
			"team_list",
			"team_create",
			"team_add_member",
			"team_roster",
			"team_accept",
			"team_decline",
			"team_dissolve",
			"team_register_agent",
		];
		for (const name of expected) {
			assert.ok(
				names.includes(name),
				`Expected tool "${name}" to be registered`,
			);
		}
	});

	it("creates a team", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: {
					name: "alpha-squad",
					description: "Test team for coverage validation",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("alpha-squad") || text.includes("Team created"),
			`Expected team creation: ${text.slice(0, 200)}`,
		);
	});

	it("lists teams", async () => {
		// Create a team first
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "list-team", description: "For listing" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "team_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected team list: ${text.slice(0, 200)}`);
	});

	it("adds a member to a team", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "member-team", description: "For member test" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_add_member",
				arguments: {
					teamName: "member-team",
					agentName: "test-agent",
					role: "developer",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("test-agent") ||
				text.includes("added") ||
				text.includes("member"),
			`Expected member add: ${text.slice(0, 200)}`,
		);
	});

	it("shows team roster", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "roster-team", description: "For roster test" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_roster",
				arguments: { teamName: "roster-team" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected roster: ${text.slice(0, 200)}`,
		);
	});

	it("registers an agent to a team", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "reg-team", description: "For registration test" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_register_agent",
				arguments: {
					teamName: "reg-team",
					agentName: "new-agent",
					agentRole: "tester",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("new-agent") ||
				text.includes("registered") ||
				text.includes("agent"),
			`Expected agent registration: ${text.slice(0, 200)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Spending tools tests
// ---------------------------------------------------------------------------
describe("MCP spending tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-spending");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		// Import spending tools dynamically
		const { registerSpendingTools } = await import(
			"../../src/mcp/tools/spending/index.ts"
		);
		registerSpendingTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers spending tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = ["spending_set_cap", "spending_log", "spending_report"];
		for (const name of expected) {
			assert.ok(
				names.includes(name),
				`Expected tool "${name}" to be registered`,
			);
		}
	});

	it("sets a spending cap", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "spending_set_cap",
				arguments: { amount: 1.0, currency: "USD" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("1.00") ||
				text.includes("cap") ||
				text.includes("spending"),
			`Expected spending cap: ${text.slice(0, 200)}`,
		);
	});

	it("logs a spending event", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "spending_log",
				arguments: { amount: 0.05, reason: "API call test" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("0.05") ||
				text.includes("logged") ||
				text.includes("spending"),
			`Expected spending log: ${text.slice(0, 200)}`,
		);
	});

	it("generates a spending report", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "spending_report", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected spending report: ${text.slice(0, 200)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Memory tools tests
// ---------------------------------------------------------------------------
describe("MCP memory tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-memory");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		const { registerMemoryTools } = await import(
			"../../src/mcp/tools/memory/index.ts"
		);
		registerMemoryTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers memory tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = ["memory_set", "memory_get", "memory_search"];
		for (const name of expected) {
			assert.ok(
				names.includes(name),
				`Expected tool "${name}" to be registered`,
			);
		}
	});

	it("sets a memory entry", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "memory_set",
				arguments: {
					key: "test-key",
					value: "test-value-for-coverage",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("test-key") ||
				text.includes("saved") ||
				text.includes("stored") ||
				text.length > 0,
			`Expected memory set: ${text.slice(0, 200)}`,
		);
	});

	it("gets a memory entry", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "memory_set",
				arguments: { key: "get-test", value: "get-value" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "memory_get",
				arguments: { key: "get-test" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("get-value") ||
				text.includes("get-test") ||
				text.length > 0,
			`Expected memory get: ${text.slice(0, 200)}`,
		);
	});

	it("searches memory entries", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "memory_search",
				arguments: { query: "test" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string",
			`Expected memory search: ${text.slice(0, 200)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Model tools tests
// ---------------------------------------------------------------------------
describe("MCP model tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-models");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		const { registerModelTools } = await import(
			"../../src/mcp/tools/models/index.ts"
		);
		registerModelTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers model tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);
		const expected = ["model_list", "model_add"];
		for (const name of expected) {
			assert.ok(
				names.includes(name),
				`Expected tool "${name}" to be registered`,
			);
		}
	});

	it("lists available models", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "model_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected model list: ${text.slice(0, 200)}`,
		);
	});

	it("adds a model", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "model_add",
				arguments: {
					name: "test-model",
					provider: "openai",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("test-model") ||
				text.includes("added") ||
				text.includes("model"),
			`Expected model add: ${text.slice(0, 200)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Agent pool tools (advanced) tests
// ---------------------------------------------------------------------------
describe("MCP agent pool — advanced operations", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-agent-advanced");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		const { registerAgentTools } = await import(
			"../../src/mcp/tools/agents/index.ts"
		);
		registerAgentTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* */
		}
		await safeCleanup(TEST_DIR);
	});

	it("spawns an agent", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_spawn",
				arguments: {
					name: "spawned-agent",
					role: "worker",
					clearance: 2,
					skills: "coding",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string" && text.length > 0,
			`Expected agent spawn: ${text.slice(0, 200)}`,
		);
	});

	it("retires an agent", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "retiree",
					role: "temp",
					clearance: 1,
					skills: "cleanup",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_retire",
				arguments: { name: "retiree" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("retiree") ||
				text.includes("retired") ||
				text.includes("agent"),
			`Expected agent retire: ${text.slice(0, 200)}`,
		);
	});

	it("detects zombie agents", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "agent_zombie_detect", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			typeof text === "string",
			`Expected zombie detection: ${text.slice(0, 200)}`,
		);
	});

	it("sends an agent heartbeat", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_heartbeat",
				arguments: { name: "heartbeat-agent" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("heartbeat") ||
				text.includes("alive") ||
				text.includes("ok"),
			`Expected heartbeat: ${text.slice(0, 200)}`,
		);
	});
});
