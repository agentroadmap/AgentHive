/**
 * proposal-77: SpacetimeDB Agent Registry - Dynamic Multi-Model Agent Pool Tests
 *
 * Tests for the agent pool handlers, schemas, and views.
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { AgentPoolHandlers } from "../mcp/tools/agents/handlers.ts";
import type { MultiModelAgent } from "../mcp/tools/agents/handlers.ts";
import {
	queryIdleAgents,
	getAgentPoolStats,
	selectBestAgent,
	getStaleAgents,
	formatAgentStatus,
} from "../spacetime/views/agent-pool.ts";

// Helper to extract text from CallToolResult
function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const item = result.content[0];
	if (!item) return "";
	return "text" in item ? (item.text as string) : "";
}

// Mock server for testing
const mockServer = {
	registerAgent: async () => ({ name: "test", trustScore: 100, lastSeen: new Date().toISOString(), status: "idle", capabilities: [] }),
	listAgents: async () => [],
};

describe("proposal-77: Agent Pool - Dynamic Multi-Model", () => {
	describe("Agent Registration (AC#3)", () => {
		let handlers: AgentPoolHandlers;

		beforeEach(() => {
			handlers = new AgentPoolHandlers(mockServer as any);
		});

		it("should register a Claude agent", async () => {
			const result = await handlers.registerAgent({
				name: "claude-dev-1",
				template: "senior-developer",
				model: "claude-3-opus-20240229",
				provider: "anthropic",
				capabilities: ["typescript", "testing", "threejs"],
				identity: "claude@example.com",
			});

			assert.ok(getText(result).includes("registered successfully"));
			assert.ok(getText(result).includes("claude-3-opus-20240229"));
			assert.ok(getText(result).includes("anthropic"));
		});

		it("should register a GPT agent", async () => {
			const result = await handlers.registerAgent({
				name: "gpt-reviewer-1",
				template: "reviewer",
				model: "gpt-4o",
				provider: "openai",
				capabilities: ["code-review", "testing"],
			});

			assert.ok(getText(result).includes("registered successfully"));
			assert.ok(getText(result).includes("gpt-4o"));
		});

		it("should register a Gemini agent", async () => {
			const result = await handlers.registerAgent({
				name: "gemini-tester-1",
				template: "tester",
				model: "gemini-pro",
				provider: "google",
				capabilities: ["testing", "automation"],
			});

			assert.ok(getText(result).includes("registered successfully"));
			assert.ok(getText(result).includes("gemini-pro"));
		});

		it("should register a local model agent", async () => {
			const result = await handlers.registerAgent({
				name: "local-dev-1",
				template: "developer",
				model: "local-llama-70b",
				provider: "local",
				capabilities: ["typescript"],
				config: {
					baseUrl: "http://localhost:11434/v1",
				},
			});

			assert.ok(getText(result).includes("registered successfully"));
			assert.ok(getText(result).includes("local-llama-70b"));
			assert.ok(getText(result).includes("http://localhost:11434/v1"));
		});

		it("should register a custom provider agent", async () => {
			const result = await handlers.registerAgent({
				name: "custom-arch-1",
				template: "architect",
				model: "custom-model-v1",
				provider: "custom",
				capabilities: ["architecture", "design"],
				config: {
					baseUrl: "https://api.custom.ai/v1",
					temperature: 0.7,
					maxTokens: 4096,
				},
			});

			assert.ok(getText(result).includes("registered successfully"));
			assert.ok(getText(result).includes("custom-model-v1"));
		});
	});

	describe("Agent Listing (AC#6)", () => {
		let handlers: AgentPoolHandlers;

		beforeEach(async () => {
			handlers = new AgentPoolHandlers(mockServer as any);

			// Register multiple agents
			await handlers.registerAgent({
				name: "claude-1",
				template: "senior-developer",
				model: "claude-3-opus",
				provider: "anthropic",
				capabilities: ["typescript", "testing"],
			});

			await handlers.registerAgent({
				name: "gpt-1",
				template: "tester",
				model: "gpt-4o",
				provider: "openai",
				capabilities: ["testing", "automation"],
			});

			await handlers.registerAgent({
				name: "local-1",
				template: "developer",
				model: "local-llama",
				provider: "local",
				capabilities: ["typescript"],
			});
		});

		it("should list all agents", async () => {
			const result = await handlers.listAgents({});
			const text = getText(result) as string;

			assert.ok(text.includes("Total: 3 agents"));
			assert.ok(text.includes("claude-3-opus"));
			assert.ok(text.includes("gpt-4o"));
			assert.ok(text.includes("local-llama"));
		});

		it("should filter by provider", async () => {
			const result = await handlers.listAgents({ provider: "anthropic" });
			const text = getText(result) as string;

			assert.ok(text.includes("claude-3-opus"));
			assert.ok(!text.includes("gpt-4o"));
			assert.ok(!text.includes("local-llama"));
		});

		it("should filter by capabilities", async () => {
			const result = await handlers.listAgents({ capabilities: ["testing"] });
			const text = getText(result) as string;

			assert.ok(text.includes("Total: 2 agents"));
			assert.ok(text.includes("claude-3-opus"));
			assert.ok(text.includes("gpt-4o"));
			assert.ok(!text.includes("local-llama"));
		});
	});

	describe("Work Assignment (AC#6)", () => {
		let handlers: AgentPoolHandlers;
		const testAgentId = "anthropic-dev-1";

		beforeEach(async () => {
			handlers = new AgentPoolHandlers(mockServer as any);
			await handlers.registerAgent({
				id: testAgentId,
				name: "claude-dev",
				template: "senior-developer",
				model: "claude-3-opus",
				provider: "anthropic",
				capabilities: ["typescript"],
			});
		});

		it("should assign work to an idle agent", async () => {
			const result = await handlers.assignWork({
				agentId: testAgentId,
				proposalId: "proposal-77",
				priority: "high",
			});

			assert.ok(getText(result).includes("assigned successfully"));
			assert.ok(getText(result).includes("proposal-77"));
		});

		it("should reject assignment to offline agent", async () => {
			// First retire the agent
			await handlers.retireAgent({
				agentId: testAgentId,
				reason: "testing",
			});

			await assert.rejects(
				() =>
					handlers.assignWork({
						agentId: testAgentId,
						proposalId: "proposal-77",
					}),
				{ message: /offline/i },
			);
		});
	});

	describe("Heartbeat & Zombie Detection (AC#5)", () => {
		let handlers: AgentPoolHandlers;
		const testAgentId = "openai-dev-1";

		beforeEach(async () => {
			handlers = new AgentPoolHandlers(mockServer as any);
			await handlers.registerAgent({
				id: testAgentId,
				name: "test-agent",
				template: "developer",
				model: "gpt-4o",
				provider: "openai",
				capabilities: ["typescript"],
			});
		});

		it("should receive heartbeat and update agent status", async () => {
			const result = await handlers.heartbeat({
				agentId: testAgentId,
				load: 50,
				claimsCount: 2,
				latencyMs: 100,
			});

			assert.ok(getText(result).includes("Heartbeat received"));
		});

		it("should detect no zombies when all agents are healthy", async () => {
			// Send fresh heartbeat
			await handlers.heartbeat({
				agentId: testAgentId,
				load: 20,
				claimsCount: 0,
			});

			const result = await handlers.detectZombies();
			assert.ok(getText(result).includes("No zombie agents detected"));
		});
	});

	describe("Spawn & Retire (AC#2)", () => {
		let handlers: AgentPoolHandlers;
		const retireAgentId = "openai-tester-1";

		beforeEach(async () => {
			handlers = new AgentPoolHandlers(mockServer as any);
		});

		it("should create a spawn request", async () => {
			const result = await handlers.spawnAgent({
				template: "senior-developer",
				model: "claude-3-opus",
				provider: "anthropic",
				capabilities: ["typescript", "threejs"],
				reason: "Need specialized 3D developer for project",
			});

			assert.ok(getText(result).includes("Spawn request created"));
			assert.ok(getText(result).includes("Pending approval"));
		});

		it("should retire an agent and release claims", async () => {
			await handlers.registerAgent({
				id: retireAgentId,
				name: "temp-agent",
				template: "tester",
				model: "gpt-4o-mini",
				provider: "openai",
				capabilities: ["testing"],
			});

			const result = await handlers.retireAgent({
				agentId: retireAgentId,
				reason: "Project complete",
				releaseClaims: true,
			});

			assert.ok(getText(result).includes("Agent retired"));
			assert.ok(getText(result).includes("Project complete"));
		});
	});

	describe("Pool Statistics", () => {
		let handlers: AgentPoolHandlers;

		beforeEach(async () => {
			handlers = new AgentPoolHandlers(mockServer as any);

			// Register diverse agents
			await handlers.registerAgent({
				name: "claude-1",
				template: "senior-developer",
				model: "claude-3-opus",
				provider: "anthropic",
				capabilities: ["typescript"],
			});

			await handlers.registerAgent({
				name: "gpt-1",
				template: "tester",
				model: "gpt-4o",
				provider: "openai",
				capabilities: ["testing"],
			});

			await handlers.registerAgent({
				name: "gemini-1",
				template: "developer",
				model: "gemini-pro",
				provider: "google",
				capabilities: ["python"],
			});

			await handlers.registerAgent({
				name: "local-1",
				template: "developer",
				model: "local-llama",
				provider: "local",
				capabilities: ["typescript"],
			});
		});

		it("should return accurate pool statistics", async () => {
			const result = await handlers.getPoolStats();
			const text = getText(result) as string;

			assert.ok(text.includes("Total Agents: 4"));
			assert.ok(text.includes("Anthropic (Claude): 1"));
			assert.ok(text.includes("OpenAI (GPT): 1"));
			assert.ok(text.includes("Google (Gemini): 1"));
			assert.ok(text.includes("Local: 1"));
		});
	});
});

describe("proposal-77: Agent Pool Views", () => {
	const testAgents: MultiModelAgent[] = [
		{
			id: "claude-dev-1",
			template: "senior-developer",
			model: "claude-3-opus",
			provider: "anthropic",
			status: "idle",
			capabilities: ["typescript", "testing", "threejs"],
			identity: "claude@example.com",
			workspace: "/workspace/1",
			machineId: "machine-1",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			trustScore: 95,
			claimsCount: 0,
			completedCount: 10,
			errorCount: 0,
			config: {},
		},
		{
			id: "gpt-reviewer-1",
			template: "reviewer",
			model: "gpt-4o",
			provider: "openai",
			status: "busy",
			capabilities: ["code-review", "testing"],
			identity: "gpt@example.com",
			workspace: "/workspace/2",
			machineId: "machine-1",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			trustScore: 88,
			claimsCount: 3,
			completedCount: 25,
			errorCount: 2,
			config: {},
		},
		{
			id: "gemini-tester-1",
			template: "tester",
			model: "gemini-pro",
			provider: "google",
			status: "idle",
			capabilities: ["testing", "automation"],
			identity: "gemini@example.com",
			workspace: "/workspace/3",
			machineId: "machine-2",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			trustScore: 75,
			claimsCount: 0,
			completedCount: 5,
			errorCount: 1,
			config: {},
		},
	];

	it("queryIdleAgents should return only idle/online agents", () => {
		const idle = queryIdleAgents(testAgents);
		assert.strictEqual(idle.length, 2);
		assert.ok(idle.every(a => a.status === "idle" || a.status === "online"));
	});

	it("queryIdleAgents should filter by capabilities", () => {
		const withTesting = queryIdleAgents(testAgents, {
			capabilities: ["testing"],
		});
		assert.strictEqual(withTesting.length, 2); // claude and gemini
	});

	it("queryIdleAgents should filter by provider", () => {
		const anthropicAgents = queryIdleAgents(testAgents, {
			provider: "anthropic",
		});
		assert.strictEqual(anthropicAgents.length, 1);
		assert.strictEqual(anthropicAgents[0]?.provider, "anthropic");
	});

	it("getAgentPoolStats should return accurate statistics", () => {
		const stats = getAgentPoolStats(testAgents);

		assert.strictEqual(stats.totalAgents, 3);
		assert.strictEqual(stats.idleAgents, 2);
		assert.strictEqual(stats.busyAgents, 1);
		assert.strictEqual(stats.totalClaims, 3);
		assert.strictEqual(stats.byProvider.anthropic, 1);
		assert.strictEqual(stats.byProvider.openai, 1);
		assert.strictEqual(stats.byProvider.google, 1);
	});

	it("selectBestAgent should prefer trusted idle agents", () => {
		const best = selectBestAgent(testAgents, {
			requiredCapabilities: ["testing"],
		});

		assert.ok(best);
		assert.strictEqual(best.id, "claude-dev-1"); // Highest trust score
	});

	it("selectBestAgent should return null when no match", () => {
		const best = selectBestAgent(testAgents, {
			requiredCapabilities: ["nonexistent-skill"],
		});
		assert.strictEqual(best, null);
	});

	it("getStaleAgents should detect stale agents", () => {
		const staleAgents: MultiModelAgent[] = [
			{
				...testAgents[0]!,
				heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
			},
		];

		const stale = getStaleAgents(staleAgents, [], 5 * 60 * 1000);
		assert.strictEqual(stale.length, 1);
		assert.ok(stale[0]?.lastHeartbeatMs! > 5 * 60 * 1000);
	});

	it("formatAgentStatus should produce readable output", () => {
		const formatted = formatAgentStatus(testAgents[0]!);
		assert.ok(formatted.includes("claude-dev-1"));
		assert.ok(formatted.includes("senior-developer"));
		assert.ok(formatted.includes("claude-3-opus"));
		assert.ok(formatted.includes("Trust: 95/100")); // Just check for trust score which is definitely there
		// Provider is shown as emoji (🟣) not text
	});
});
