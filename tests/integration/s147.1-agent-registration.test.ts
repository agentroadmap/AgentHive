/**
 * S147.1 Tests: Agent Startup Registration
 *
 * Tests for agent registration, channel binding, and lifecycle.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	deregisterAgent,
	getAgent,
	listAgents,
	registerAgent,
	updateAgentStatus,
} from "../../src/core/identity/agent-registry/index.ts";

describe("S147.1: Agent Startup Registration", () => {
	describe("AC#1: Agent registers ID on startup", () => {
		it("should register a new agent with ID and capabilities", async () => {
			const result = await registerAgent({
				agentId: "xGit1",
				instanceId: "xGit1-test1",
				capabilities: ["git", "review"],
			});

			assert.strictEqual(result.success, true);
			assert.ok(result.channel, "Channel should be assigned");
		});

		it("should generate channel name from instance ID", async () => {
			const result = await registerAgent({
				agentId: "xDev2",
				instanceId: "xDev2-test1",
				capabilities: ["code"],
			});

			assert.strictEqual(result.channel, "agent-xdev2-test1");
		});

		it("should accept custom channel name", async () => {
			const result = await registerAgent({
				agentId: "xTest1",
				instanceId: "xTest1-custom",
				channel: "custom-channel",
			});

			assert.strictEqual(result.channel, "custom-channel");
		});
	});

	describe("AC#2: System assigns unique channel", () => {
		it("should assign unique channels to different agents", async () => {
			const r1 = await registerAgent({
				agentId: "agent-a",
				instanceId: "agent-a-1",
			});
			const r2 = await registerAgent({
				agentId: "agent-b",
				instanceId: "agent-b-1",
			});

			assert.notStrictEqual(r1.channel, r2.channel);
		});
	});

	describe("AC#3: Agent appears in agent_list()", () => {
		it("should list registered agents", async () => {
			await registerAgent({
				agentId: "list-test-1",
				instanceId: "list-test-1-inst",
			});

			const agents = await listAgents();
			const found = agents.find((a) => a.agentId === "list-test-1");

			assert.ok(found, "Agent should appear in list");
			assert.strictEqual(found.status, "online");
		});

		it("should filter agents by status", async () => {
			await registerAgent({
				agentId: "filter-test",
				instanceId: "filter-test-inst",
			});

			const online = await listAgents({ status: "online" });
			assert.ok(online.some((a) => a.agentId === "filter-test"));
		});
	});

	describe("AC#4: Re-registration preserves history", () => {
		it("should preserve original registration time on re-register", async () => {
			const instanceId = "rereg-test-inst";
			await registerAgent({ agentId: "rereg-test", instanceId });
			const original = await getAgent(instanceId);
			const originalTime = original?.registeredAt;

			// Wait a bit and re-register
			await new Promise((resolve) => setTimeout(resolve, 10));
			await registerAgent({ agentId: "rereg-test", instanceId });
			const reregistered = await getAgent(instanceId);

			assert.strictEqual(reregistered?.registeredAt, originalTime);
		});
	});

	describe("AC#5: Agent status updates on shutdown", () => {
		it("should mark agent as offline on deregister", async () => {
			await registerAgent({
				agentId: "shutdown-test",
				instanceId: "shutdown-test-inst",
			});

			await deregisterAgent({
				agentId: "shutdown-test-inst",
				reason: "test shutdown",
			});

			const agent = await getAgent("shutdown-test-inst");
			assert.strictEqual(agent?.status, "offline");
		});
	});

	describe("Status updates", () => {
		it("should update agent status and current task", async () => {
			await registerAgent({
				agentId: "status-test",
				instanceId: "status-test-inst",
			});

			await updateAgentStatus(
				"status-test-inst",
				"busy",
				"Implementing S147.1",
			);

			const agent = await getAgent("status-test-inst");
			assert.strictEqual(agent?.status, "busy");
			assert.strictEqual(agent?.currentTask, "Implementing S147.1");
		});
	});

	describe("Contract agent instance IDs", () => {
		it("should auto-generate unique instance ID for contract agents", async () => {
			const r1 = await registerAgent({ agentId: "xGit1" });
			const r2 = await registerAgent({ agentId: "xGit1" });

			// Different instance IDs
			assert.notStrictEqual(r1.agentId, r2.agentId);
			// Both share same agent role
			const agents = await listAgents();
			const a1 = agents.find((a) => a.instanceId === r1.agentId);
			const a2 = agents.find((a) => a.instanceId === r2.agentId);
			assert.strictEqual(a1?.agentId, "xGit1");
			assert.strictEqual(a2?.agentId, "xGit1");
		});

		it("should mark permanent agents correctly", async () => {
			await registerAgent({ agentId: "Andy" });

			const agent = await getAgent("Andy");
			assert.strictEqual(agent?.agentType, "permanent");
		});

		it("should mark contract agents correctly", async () => {
			await registerAgent({ agentId: "xDev1", instanceId: "xDev1-contract" });

			const agent = await getAgent("xDev1-contract");
			assert.strictEqual(agent?.agentType, "contract");
		});
	});
});
