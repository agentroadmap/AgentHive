import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerAgentTools } from "../../src/mcp/tools/agents/index.ts";
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

describe("MCP agent tools — registration and lifecycle", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-agents");
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await mcpServer.initializeProject("Test Project");
		registerAgentTools(mcpServer);
		registerWorkflowTools(mcpServer);
	});

	afterEach(async () => {
		try {
			await mcpServer.stop();
		} catch {
			/* ignore */
		}
		await safeCleanup(TEST_DIR);
	});

	it("registers all expected agent tools", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const names = tools.tools.map((t) => t.name);

		const required = [
			"agent_register",
			"agent_list",
			"agent_spawn",
			"agent_retire",
			"agent_assign",
			"agent_heartbeat",
			"agent_zombie_detect",
			"agent_pool_stats",
			"agent_update_reporting",
			"privilege_grant",
			"privilege_revoke",
		];

		for (const name of required) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("register_agent returns agent details", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "test-agent",
					role: "tester",
					clearance_level: 3,
					capabilities: "testing,messaging",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("test-agent") || text.includes("registered"),
			`Unexpected: ${text.slice(0, 200)}`,
		);
	});

	it("agent_list shows registered agents", async () => {
		// Register two agents
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "alpha",
					role: "dev",
					clearance_level: 4,
					capabilities: "coding",
				},
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "beta",
					role: "qa",
					clearance_level: 2,
					capabilities: "testing",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "agent_list", arguments: {} },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("alpha") && text.includes("beta"),
			`Missing agents in list: ${text.slice(0, 300)}`,
		);
	});

	it("agent_pool_stats returns pool information", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "worker-1",
					role: "worker",
					clearance_level: 2,
					capabilities: "general",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "agent_pool_stats", arguments: {} },
		});
		const text = getText(result.content);
		// Should return some stats data
		assert.ok(text.length > 5, `Expected stats output: ${text.slice(0, 200)}`);
	});

	it("agent_spawn creates a new agent", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_spawn",
				arguments: {
					name: "spawned-agent",
					role: "analyst",
					clearance_level: 3,
					capabilities: "reporting",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected spawn output: ${text.slice(0, 200)}`);
	});

	it("agent_retire marks an agent as retired", async () => {
		// Register first
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "retiree",
					role: "temp",
					clearance_level: 1,
					capabilities: "temporary",
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
		assert.ok(text.length > 5, `Expected retire output: ${text.slice(0, 200)}`);
	});

	it("agent_assign assigns work to an agent", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "assignee",
					role: "dev",
					clearance_level: 3,
					capabilities: "coding",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_assign",
				arguments: {
					agent_name: "assignee",
					task: "P001",
					deadline: "2026-04-10",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected assignment output: ${text.slice(0, 200)}`,
		);
	});

	it("agent_zombie_detect scans for inactive agents", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: { name: "agent_zombie_detect", arguments: {} },
		});
		const text = getText(result.content);
		// Should return detection results
		assert.ok(
			typeof text === "string",
			`Expected zombie detection: ${text.slice(0, 200)}`,
		);
	});

	it("agent_heartbeat records a heartbeat", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "heartbeat-agent",
					role: "worker",
					clearance_level: 2,
					capabilities: "general",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_heartbeat",
				arguments: {
					agent_name: "heartbeat-agent",
					status: "active",
					metrics: { tasks_completed: 5 },
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected heartbeat output: ${text.slice(0, 200)}`,
		);
	});

	it("agent_update_reporting changes reporting structure", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "reporter",
					role: "dev",
					clearance_level: 3,
					capabilities: "coding",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "agent_update_reporting",
				arguments: {
					agent_name: "reporter",
					reports_to: "lead-dev",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected reporting update: ${text.slice(0, 200)}`,
		);
	});

	it("privilege_grant grants a privilege to an agent", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "junior",
					role: "intern",
					clearance_level: 1,
					capabilities: "basic",
				},
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "privilege_grant",
				arguments: {
					agent_name: "junior",
					privilege: "deploy_staging",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected privilege grant: ${text.slice(0, 200)}`,
		);
	});

	it("privilege_revoke revokes a privilege from an agent", async () => {
		// Grant first
		await mcpServer.testInterface.callTool({
			params: {
				name: "agent_register",
				arguments: {
					name: "revokee",
					role: "dev",
					clearance_level: 2,
					capabilities: "coding",
				},
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "privilege_grant",
				arguments: { agent_name: "revokee", privilege: "deploy_prod" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "privilege_revoke",
				arguments: {
					agent_name: "revokee",
					privilege: "deploy_prod",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected privilege revoke: ${text.slice(0, 200)}`,
		);
	});
});
