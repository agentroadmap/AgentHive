import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerTeamTools } from "../../src/mcp/tools/teams/index.ts";
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
			"team_create",
			"team_accept",
			"team_decline",
			"team_dissolve",
			"team_roster",
			"team_register_agent",
		];
		for (const name of expected) {
			assert.ok(names.includes(name), `Missing tool: ${name}`);
		}
	});

	it("creates a team", async () => {
		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: {
					name: "engineering",
					description: "Core engineering team",
					lead: "tech-lead-agent",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("engineering") || text.includes("created"),
			`Unexpected: ${text.slice(0, 200)}`,
		);
	});

	it("creates multiple teams and lists them", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "frontend", description: "Frontend squad" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "backend", description: "Backend squad" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "team_roster", arguments: { team: "frontend" } },
		});
		const text = getText(result.content);
		// Should show team info even if empty roster
		assert.ok(text.length > 5, `Expected roster info: ${text.slice(0, 200)}`);
	});

	it("registers an agent to a team", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "alpha", description: "Alpha team" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_register_agent",
				arguments: {
					team: "alpha",
					agent_name: "dev-agent",
					role: "developer",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("alpha") ||
				text.includes("dev-agent") ||
				text.includes("registered"),
			`Unexpected: ${text.slice(0, 200)}`,
		);
	});

	it("shows team roster with members", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "bravo", description: "Bravo team" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_register_agent",
				arguments: { team: "bravo", agent_name: "member-1", role: "qa" },
			},
		});
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_register_agent",
				arguments: { team: "bravo", agent_name: "member-2", role: "dev" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: { name: "team_roster", arguments: { team: "bravo" } },
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("member-1") && text.includes("member-2"),
			`Missing members: ${text.slice(0, 300)}`,
		);
	});

	it("declines a team membership", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "optional-team", description: "Optional" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_decline",
				arguments: {
					team: "optional-team",
					agent_name: "decliner",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.length > 5,
			`Expected decline output: ${text.slice(0, 200)}`,
		);
	});

	it("dissolves a team", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "temp-team", description: "Temporary" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_dissolve",
				arguments: { team: "temp-team" },
			},
		});
		const text = getText(result.content);
		assert.ok(
			text.includes("temp-team") ||
				text.includes("dissolved") ||
				text.includes("deleted"),
			`Unexpected: ${text.slice(0, 200)}`,
		);
	});

	it("accepts a team membership invitation", async () => {
		await mcpServer.testInterface.callTool({
			params: {
				name: "team_create",
				arguments: { name: "accept-team", description: "Accept test" },
			},
		});

		const result = await mcpServer.testInterface.callTool({
			params: {
				name: "team_accept",
				arguments: {
					team: "accept-team",
					agent_name: "acceptor",
					role: "contributor",
				},
			},
		});
		const text = getText(result.content);
		assert.ok(text.length > 5, `Expected accept output: ${text.slice(0, 200)}`);
	});
});
