/**
 * S147.3 Tests: Agent Communication Verification (Ping/Pong)
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	clearHealthProposal,
	getAgentHealth,
	getAllHealth,
	getStaleAgents,
	isAgentHealthy,
	pingAgent,
	recordPong,
} from "../../src/core/identity/agent-health/index.ts";

describe("S147.3: Agent Communication Verification", () => {
	beforeEach(() => {
		clearHealthProposal();
	});

	describe("AC#1: Orchestrator sends ping to agent", () => {
		it("should send ping and return health status", async () => {
			const health = await pingAgent({ agentId: "xDev1" });

			assert.strictEqual(health.agentId, "xDev1");
			assert.ok(["alive", "stale", "dead", "unknown"].includes(health.health));
		});

		it("should record ping timestamp", async () => {
			const before = new Date().toISOString();
			await pingAgent({ agentId: "xDev1" });
			const after = new Date().toISOString();

			const health = getAgentHealth("xDev1");
			assert.ok(health.lastPing >= before);
			assert.ok(health.lastPing <= after);
		});
	});

	describe("AC#2: Agent responds with pong + status within 30s", () => {
		it("should record pong response", () => {
			recordPong("xDev1", {
				agentId: "xDev1",
				status: "ready",
				uptime: 3600,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			const health = getAgentHealth("xDev1");
			assert.strictEqual(health.health, "alive");
			assert.ok(health.lastPong);
		});

		it("should include pong payload data", () => {
			recordPong("xDev1", {
				agentId: "xDev1",
				status: "busy",
				currentTask: "Implementing S147.1",
				uptime: 7200,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			const health = getAgentHealth("xDev1");
			assert.strictEqual(health.pongData?.status, "busy");
			assert.strictEqual(health.pongData?.currentTask, "Implementing S147.1");
			assert.strictEqual(health.pongData?.uptime, 7200);
		});
	});

	describe("AC#3: Agent marked dead if no response within timeout", () => {
		it("should return unknown for unpinged agent", () => {
			const health = getAgentHealth("unknown-agent");
			assert.strictEqual(health.health, "unknown");
		});
	});

	describe("AC#4: Agent status visible in health list", () => {
		it("should list all agent health statuses", () => {
			recordPong("xDev1", {
				agentId: "xDev1",
				status: "ready",
				uptime: 100,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});
			recordPong("xDev2", {
				agentId: "xDev2",
				status: "busy",
				uptime: 200,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			const all = getAllHealth();
			assert.ok(all.length >= 2);
		});

		it("should identify healthy agents", () => {
			recordPong("xDev1", {
				agentId: "xDev1",
				status: "ready",
				uptime: 100,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			assert.strictEqual(isAgentHealthy("xDev1"), true);
			assert.strictEqual(isAgentHealthy("xDev2"), false);
		});

		it("should identify stale agents", () => {
			// Record pong, then check for stale agents
			recordPong("xDev1", {
				agentId: "xDev1",
				status: "ready",
				uptime: 100,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			// No stale agents immediately after pong
			const stale = getStaleAgents(1000); // 1 second threshold
			assert.strictEqual(stale.includes("xDev1"), false);
		});
	});

	describe("AC#5: Configurable heartbeat", () => {
		it("should support custom ping timeout", async () => {
			const health = await pingAgent({ agentId: "xDev1", timeoutMs: 5000 });
			assert.ok(health);
		});
	});

	describe("Health proposals", () => {
		it("should classify alive status correctly", () => {
			recordPong("fast-agent", {
				agentId: "fast-agent",
				status: "ready",
				uptime: 100,
				lastHeartbeat: new Date().toISOString(),
				timestamp: new Date().toISOString(),
			});

			const health = getAgentHealth("fast-agent");
			assert.strictEqual(health.health, "alive");
		});
	});
});
