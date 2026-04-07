/**
 * Tests for proposal-44: Per-Agent Rate Limiting & Fair Share
 * - Configurable claim limit per agent per hour
 * - Queue system when limit complete
 * - Priority boost for critical proposals bypasses limit
 * - Rate limit status visible in agent profile
 * - Global fair-share policy configurable
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RateLimiter } from "../../src/core/infrastructure/rate-limiter.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-rate-limiter");

describe("proposal-44: Per-Agent Rate Limiting & Fair Share", () => {
	let testDir: string;
	let limiter: RateLimiter;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });
		limiter = new RateLimiter(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("AC#1: Configurable claim limit per agent per hour", () => {
		it("allows claims within limit", () => {
			const result = limiter.canClaim("agent-1", "proposal-1", "medium");
			assert.equal(result.allowed, true);
			assert.equal(result.bypassed, false);
		});

		it("blocks claims after limit complete", () => {
			// Set low limit for testing
			limiter.updateConfig({ maxClaimsPerHour: 3 });

			for (let i = 0; i < 3; i++) {
				limiter.recordClaim("agent-1", `proposal-${i + 1}`);
			}

			const result = limiter.canClaim("agent-1", "proposal-4");
			assert.equal(result.allowed, false);
			assert.ok(result.reason?.includes("Rate limit"));
		});

		it("allows different agents independently", () => {
			limiter.updateConfig({ maxClaimsPerHour: 2 });

			for (let i = 0; i < 2; i++) {
				limiter.recordClaim("agent-1", `proposal-${i + 1}`);
			}

			// agent-1 should be limited
			const r1 = limiter.canClaim("agent-1", "proposal-3");
			assert.equal(r1.allowed, false);

			// agent-2 should still be allowed
			const r2 = limiter.canClaim("agent-2", "proposal-3");
			assert.equal(r2.allowed, true);
		});

		it("respects custom limit configuration", () => {
			limiter.updateConfig({ maxClaimsPerHour: 1 });

			limiter.recordClaim("agent-1", "proposal-1");

			const result = limiter.canClaim("agent-1", "proposal-2");
			assert.equal(result.allowed, false);
		});
	});

	describe("AC#2: Queue system when limit complete", () => {
		it("adds to queue when limit complete", () => {
			limiter.updateConfig({ maxClaimsPerHour: 1, coolDownMinutes: 5 });

			limiter.recordClaim("agent-1", "proposal-1");

			const result = limiter.canClaim("agent-1", "proposal-2");
			assert.equal(result.allowed, false);
			assert.ok(result.queuePosition);
			assert.ok(result.queuePosition >= 1);
			assert.ok(result.retryAfter);
		});

		it("reports queue position", () => {
			limiter.updateConfig({ maxClaimsPerHour: 0 });

			// Multiple attempts should increase queue position
			limiter.canClaim("agent-1", "proposal-1");
			limiter.canClaim("agent-1", "proposal-2");

			const queue = limiter.getAgentQueue("agent-1");
			assert.ok(queue.length >= 1);
		});

		it("provides retry-after timestamp", () => {
			limiter.updateConfig({ maxClaimsPerHour: 1, coolDownMinutes: 15 });

			limiter.recordClaim("agent-1", "proposal-1");

			const result = limiter.canClaim("agent-1", "proposal-2");
			assert.ok(result.retryAfter);

			const retryTime = new Date(result.retryAfter!).getTime();
			const expectedMin = Date.now() + 14 * 60 * 1000; // ~15 minutes
			assert.ok(
				retryTime >= expectedMin,
				"retryAfter should be ~15 minutes out",
			);
		});
	});

	describe("AC#3: Priority boost bypasses limit", () => {
		it("bypasses limit for high priority proposals", () => {
			limiter.updateConfig({
				maxClaimsPerHour: 1,
				priorityBypass: true,
				minBypassPriority: "high",
			});

			limiter.recordClaim("agent-1", "proposal-1", "medium");

			// Medium priority should be blocked
			const r1 = limiter.canClaim("agent-1", "proposal-2", "medium");
			assert.equal(r1.allowed, false);

			// High priority should bypass
			const r2 = limiter.canClaim("agent-1", "proposal-3", "high");
			assert.equal(r2.allowed, true);
			assert.equal(r2.bypassed, true);
		});

		it("does not bypass when priorityBypass is disabled", () => {
			limiter.updateConfig({
				maxClaimsPerHour: 1,
				priorityBypass: false,
			});

			limiter.recordClaim("agent-1", "proposal-1", "medium");

			const result = limiter.canClaim("agent-1", "proposal-2", "high");
			assert.equal(result.allowed, false);
			assert.equal(result.bypassed, false);
		});

		it("bypass does not count towards burst limit", () => {
			limiter.updateConfig({
				maxClaimsPerHour: 100,
				burstAllowance: 2,
				priorityBypass: true,
				minBypassPriority: "high",
			});

			// Use up burst allowance with high priority (should not count)
			limiter.recordClaim("agent-1", "proposal-1", "high");
			limiter.recordClaim("agent-1", "proposal-2", "high");

			// High priority should still work (didn't use burst)
			const result = limiter.canClaim("agent-1", "proposal-3", "high");
			assert.equal(result.allowed, true);
		});
	});

	describe("AC#4: Rate limit status visible in agent profile", () => {
		it("reports claims in window", () => {
			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-1", "proposal-2");

			const status = limiter.getAgentStatus("agent-1");
			assert.equal(status.claimsInWindow, 2);
			assert.equal(status.agentId, "agent-1");
		});

		it("reports max allowed", () => {
			limiter.updateConfig({ maxClaimsPerHour: 5 });

			const status = limiter.getAgentStatus("agent-1");
			assert.equal(status.maxAllowed, 5);
		});

		it("reports burst usage", () => {
			limiter.updateConfig({ burstAllowance: 3 });

			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-1", "proposal-2");

			const status = limiter.getAgentStatus("agent-1");
			assert.equal(status.burstUsed, 2);
			assert.equal(status.burstRemaining, 1);
		});

		it("reports isLimited flag", () => {
			limiter.updateConfig({ maxClaimsPerHour: 2 });

			limiter.recordClaim("agent-1", "proposal-1");

			let status = limiter.getAgentStatus("agent-1");
			assert.equal(status.isLimited, false);

			limiter.recordClaim("agent-1", "proposal-2");

			status = limiter.getAgentStatus("agent-1");
			assert.equal(status.isLimited, true);
		});

		it("reports resetsAt timestamp", () => {
			limiter.recordClaim("agent-1", "proposal-1");

			const status = limiter.getAgentStatus("agent-1");
			assert.ok(status.resetsAt);

			const resetTime = new Date(status.resetsAt).getTime();
			const expectedMin = Date.now() + 55 * 60 * 1000; // ~1 hour from now
			assert.ok(
				resetTime >= expectedMin,
				"resetsAt should be ~1 hour after first claim",
			);
		});
	});

	describe("AC#5: Global fair-share policy configurable", () => {
		it("has default fair-share policy", () => {
			const policy = limiter.getFairSharePolicy();
			assert.equal(policy.enabled, true);
			assert.equal(typeof policy.minClaimsPerHour, "number");
			assert.equal(typeof policy.rebalanceIntervalMinutes, "number");
		});

		it("can update fair-share policy", () => {
			limiter.updateFairShare({
				enabled: false,
				minClaimsPerHour: 5,
			});

			const policy = limiter.getFairSharePolicy();
			assert.equal(policy.enabled, false);
			assert.equal(policy.minClaimsPerHour, 5);
		});
	});

	describe("Admin operations", () => {
		it("clears rate limit for specific agent", () => {
			limiter.updateConfig({ maxClaimsPerHour: 1 });

			limiter.recordClaim("agent-1", "proposal-1");
			assert.equal(limiter.canClaim("agent-1", "proposal-2").allowed, false);

			limiter.clearAgentLimit("agent-1");

			const status = limiter.getAgentStatus("agent-1");
			assert.equal(status.claimsInWindow, 0);
			assert.equal(limiter.canClaim("agent-1", "proposal-2").allowed, true);
		});

		it("resets all limits", () => {
			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-2", "proposal-2");

			limiter.resetAllLimits();

			const stats = limiter.getStats();
			assert.equal(stats.totalAgents, 0);
		});
	});

	describe("Statistics and monitoring", () => {
		it("reports total agents", () => {
			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-2", "proposal-2");
			limiter.recordClaim("agent-3", "proposal-3");

			const stats = limiter.getStats();
			assert.equal(stats.totalAgents, 3);
		});

		it("reports limited agents count", () => {
			limiter.updateConfig({ maxClaimsPerHour: 1 });

			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-2", "proposal-2");

			const stats = limiter.getStats();
			assert.equal(stats.limitedAgents, 2);
		});

		it("reports all agent statuses sorted by usage", () => {
			limiter.recordClaim("agent-1", "proposal-1");
			limiter.recordClaim("agent-2", "proposal-2");
			limiter.recordClaim("agent-2", "proposal-3");
			limiter.recordClaim("agent-3", "proposal-4");
			limiter.recordClaim("agent-3", "proposal-5");
			limiter.recordClaim("agent-3", "proposal-6");

			const statuses = limiter.getAllAgentStatuses();
			assert.equal(statuses[0].agentId, "agent-3"); // Most claims first
			assert.equal(statuses[0].claimsInWindow, 3);
			assert.equal(statuses[2].agentId, "agent-1"); // Least claims last
		});
	});

	describe("Persistence", () => {
		it("persists proposal across instances", () => {
			limiter.updateConfig({ maxClaimsPerHour: 5 });
			limiter.recordClaim("agent-1", "proposal-1");

			const limiter2 = new RateLimiter(testDir);

			const status = limiter2.getAgentStatus("agent-1");
			assert.equal(status.claimsInWindow, 1);
			assert.equal(status.maxAllowed, 5);
		});
	});
});
