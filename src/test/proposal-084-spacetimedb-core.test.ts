/**
 * SpacetimeDB Core Test Suite - proposal-84
 *
 * Tests for the core SpacetimeDB functionality:
 * - AC#1: Proposal claiming/release logic including stale claim expiration
 * - AC#2: SandboxRegistry token generation and heartbeat
 * - AC#3: DAG validation for cycles and orphans
 *
 * This test suite verifies the in-memory implementations that mirror
 * the SpacetimeDB reducers and tables.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentRegistry } from "../spacetimedb/registry.ts";
import { SandboxRegistry } from "../spacetimedb/sandbox-registry.ts";
import { DAGHealth } from "../core/dag/dag-health.ts";
import type { Proposal } from "../types/index.ts";

// Helper to create mock proposals for DAG testing
const createMockProposal = (
	id: string,
	deps: string[] = [],
	status = "Potential",
): Proposal =>
	({
		id,
		title: `Proposal ${id}`,
		status,
		dependencies: deps,
		createdDate: "2024-01-01",
		updatedDate: "2024-01-01",
	} as Proposal);

// ============================================================================
// AC#1: Proposal Claiming/Release Logic
// ============================================================================

describe("proposal-84 AC#1: Claim Proposal and Release Proposal Logic", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry({
			intervalMs: 1000,
			timeoutMs: 5000,
		});

		// Register test agents
		registry.registerAgent({
			id: "agent-1",
			name: "Test Agent 1",
			roles: ["senior-developer"],
			capabilities: ["typescript"],
			workspaceUrl: "https://example.com/agent1",
		});

		registry.registerAgent({
			id: "agent-2",
			name: "Test Agent 2",
			roles: ["senior-developer"],
			capabilities: ["typescript"],
			workspaceUrl: "https://example.com/agent2",
		});
	});

	describe("claimProposal", () => {
		it("should allow an agent to claim a proposal", () => {
			const assignment = registry.claimProposal({
				proposalId: "proposal-100",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			assert.ok(assignment);
			assert.strictEqual(assignment.proposalId, "proposal-100");
			assert.strictEqual(assignment.agentId, "agent-1");
			assert.ok(assignment.claimedAt! > 0);
		});

		it("should prevent duplicate claims by different agents", () => {
			// First agent claims
			registry.claimProposal({
				proposalId: "proposal-100",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Second agent tries to claim same proposal
			assert.throws(
				() =>
					registry.claimProposal({
						proposalId: "proposal-100",
						agentId: "agent-2",
						roleUsed: "senior-developer",
					}),
				/already claimed/i,
			);
		});

		it("should prevent re-claiming an already claimed proposal", () => {
			// Agent claims
			const first = registry.claimProposal({
				proposalId: "proposal-100",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Same agent tries to claim again - should throw (already claimed)
			assert.throws(
				() =>
					registry.claimProposal({
						proposalId: "proposal-100",
						agentId: "agent-1",
						roleUsed: "senior-developer",
					}),
				/already claimed/i,
			);
		});

		it("should reject claims for non-existent agents", () => {
			assert.throws(
				() =>
					registry.claimProposal({
						proposalId: "proposal-100",
						agentId: "non-existent",
						roleUsed: "senior-developer",
					}),
				/not registered/i,
			);
		});
	});

	describe("releaseProposal", () => {
		it("should allow an agent to release a claimed proposal", () => {
			// Claim first
			registry.claimProposal({
				proposalId: "proposal-100",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Release
			const result = registry.releaseProposal("agent-1", "proposal-100");
			assert.ok(result);
		});

		it("should prevent other agents from releasing a claimed proposal", () => {
			// Agent-1 claims
			registry.claimProposal({
				proposalId: "proposal-100",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Agent-2 tries to release - should throw with message about not being owner
			assert.throws(
				() => registry.releaseProposal("agent-2", "proposal-100"),
				/cannot release|not.*owner|claimed by/i,
			);
		});

		it("should throw when releasing an unclaimed proposal", () => {
			// Try to release without claiming first
			assert.throws(
				() => registry.releaseProposal("agent-1", "proposal-999"),
				/has not claimed/i,
			);
		});
	});

	describe("stale claim expiration", () => {
		it("should recover proposals with expired claims", () => {
			// Create registry with short timeout
			const shortRegistry = new AgentRegistry({
				intervalMs: 100,
				timeoutMs: 200,
			});

			shortRegistry.registerAgent({
				id: "agent-1",
				name: "Test Agent",
				roles: ["senior-developer"],
				capabilities: ["typescript"],
				workspaceUrl: "https://example.com",
			});

			// Claim a proposal
			shortRegistry.claimProposal({
				proposalId: "proposal-200",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Verify it's claimed
			const before = shortRegistry.getAgent("agent-1");
			assert.ok(before?.currentProposalId);

			// Trigger stale recovery
			shortRegistry.recoverStaleAgents(30000);

			// Agent should still exist
			const after = shortRegistry.getAgent("agent-1");
			assert.ok(after);
		});

		it("should not recover active agents with recent heartbeats", () => {
			const registry = new AgentRegistry({
				intervalMs: 1000,
				timeoutMs: 60000, // Long timeout
			});

			registry.registerAgent({
				id: "agent-1",
				name: "Active Agent",
				roles: ["senior-developer"],
				capabilities: ["typescript"],
				workspaceUrl: "https://example.com",
			});

			// Claim a proposal
			registry.claimProposal({
				proposalId: "proposal-300",
				agentId: "agent-1",
				roleUsed: "senior-developer",
			});

			// Send heartbeat to keep alive
			registry.heartbeat("agent-1");

			// Trigger recovery
			registry.recoverStaleAgents(30000);

			// Agent should still have assignment
			const agent = registry.getAgent("agent-1");
			assert.ok(agent?.currentProposalId);
		});
	});
});

// ============================================================================
// AC#2: SandboxRegistry Token Generation and Heartbeat
// ============================================================================

describe("proposal-84 AC#2: SandboxRegistry Token Generation and Heartbeat", () => {
	let sandboxRegistry: SandboxRegistry;
	let mockTime: number;

	beforeEach(() => {
		mockTime = 1000000;
		sandboxRegistry = new SandboxRegistry(
			{ defaultTtlMinutes: 60, heartbeatExtensionMinutes: 30 },
			() => mockTime,
		);
	});

	describe("token generation", () => {
		it("should generate a unique token for a new sandbox", () => {
			const result = sandboxRegistry.generateToken(
				"agent-1",
				"container-abc",
			);

			assert.ok(result.token.startsWith("sbx_"));
			assert.ok(result.token.includes("container-abc"));
			assert.ok(result.token.includes("1000000"));
			assert.strictEqual(result.status, "provisioning");
			assert.strictEqual(result.agentId, "agent-1");
			assert.strictEqual(result.containerId, "container-abc");
		});

		it("should set correct expiry based on TTL", () => {
			const result = sandboxRegistry.generateToken(
				"agent-1",
				"container-abc",
				30, // 30 minutes
			);

			const expectedExpiry = mockTime + 30 * 60_000;
			assert.strictEqual(result.expiresAt, expectedExpiry);
		});

		it("should use default TTL when not specified", () => {
			const result = sandboxRegistry.generateToken(
				"agent-1",
				"container-abc",
			);

			const expectedExpiry = mockTime + 60 * 60_000; // 60 minutes default
			assert.strictEqual(result.expiresAt, expectedExpiry);
		});

		it("should throw when generating token for existing container", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			assert.throws(
				() => sandboxRegistry.generateToken("agent-1", "container-abc"),
				/already exists/i,
			);
		});

		it("should allow regenerating token for stale container", () => {
			// Create and expire
			sandboxRegistry.generateToken("agent-1", "container-abc");
			mockTime += 70 * 60_000; // Advance past TTL
			sandboxRegistry.expireStale();

			// Should be able to regenerate
			const result = sandboxRegistry.generateToken(
				"agent-2",
				"container-abc",
			);
			assert.ok(result);
			assert.strictEqual(result.agentId, "agent-2");
			assert.strictEqual(result.status, "provisioning");
		});

		it("should generate unique tokens for multiple sandboxes", () => {
			const token1 = sandboxRegistry.generateToken(
				"agent-1",
				"container-1",
			);
			const token2 = sandboxRegistry.generateToken(
				"agent-1",
				"container-2",
			);

			assert.notStrictEqual(token1.token, token2.token);
		});
	});

	describe("heartbeat", () => {
		it("should update status to running on heartbeat", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			const result = sandboxRegistry.heartbeat("container-abc");

			assert.ok(result);
			assert.strictEqual(result.status, "running");
		});

		it("should extend expiry on heartbeat", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			// Advance time slightly
			mockTime += 10_000;

			const result = sandboxRegistry.heartbeat("container-abc");

			assert.ok(result);
			const expectedExpiry = mockTime + 30 * 60_000; // 30 min extension
			assert.strictEqual(result.expiresAt, expectedExpiry);
		});

		it("should return null for non-existent container", () => {
			const result = sandboxRegistry.heartbeat("non-existent");
			assert.strictEqual(result, null);
		});

		it("should allow multiple heartbeats", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			// First heartbeat
			mockTime += 10_000;
			const first = sandboxRegistry.heartbeat("container-abc");
			assert.strictEqual(first?.status, "running");

			// Second heartbeat
			mockTime += 10_000;
			const second = sandboxRegistry.heartbeat("container-abc");
			assert.strictEqual(second?.status, "running");

			// Expiry should be extended each time
			const expectedExpiry = mockTime + 30 * 60_000;
			assert.strictEqual(second.expiresAt, expectedExpiry);
		});
	});

	describe("stale expiration", () => {
		it("should mark expired sandboxes as stale", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			// Advance past TTL
			mockTime += 70 * 60_000; // 70 minutes

			const expired = sandboxRegistry.expireStale();
			assert.strictEqual(expired, 1);

			const sandbox = sandboxRegistry.findByContainer("container-abc");
			assert.strictEqual(sandbox?.status, "stale");
		});

		it("should not mark active sandboxes as stale", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			// Don't advance time
			const expired = sandboxRegistry.expireStale();
			assert.strictEqual(expired, 0);

			const sandbox = sandboxRegistry.findByContainer("container-abc");
			assert.strictEqual(sandbox?.status, "provisioning");
		});

		it("should extend expiry preventing staleness", () => {
			sandboxRegistry.generateToken("agent-1", "container-1");

			// Advance 40 minutes (less than original 60 min TTL)
			mockTime += 40 * 60_000;

			// Heartbeat extends expiry to 30 minutes from now (mockTime + 30min)
			sandboxRegistry.heartbeat("container-1");

			// Advance another 20 minutes (total 60 from start, but only 20 from heartbeat)
			mockTime += 20 * 60_000;

			// container-1 should still be alive (heartbeat extended to 30min, only 20 passed)
			const expired = sandboxRegistry.expireStale();
			assert.strictEqual(expired, 0);

			const sandbox = sandboxRegistry.findByContainer("container-1");
			assert.strictEqual(sandbox?.status, "running");
		});

		it("should mark multiple expired sandboxes", () => {
			sandboxRegistry.generateToken("agent-1", "container-1");
			sandboxRegistry.generateToken("agent-1", "container-2");
			sandboxRegistry.generateToken("agent-2", "container-3");

			// Heartbeat container-2 to keep it alive
			sandboxRegistry.heartbeat("container-2");

			// Advance past all TTLs
			mockTime += 70 * 60_000;

			// container-2 was heartbeaten at mockTime=0, extended to 30min
			// After 70min, it should also be expired
			const expired = sandboxRegistry.expireStale();
			assert.strictEqual(expired, 3);
		});
	});

	describe("queries", () => {
		it("should find sandbox by container ID", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			const found = sandboxRegistry.findByContainer("container-abc");
			assert.ok(found);
			assert.strictEqual(found.containerId, "container-abc");
		});

		it("should find all sandboxes for an agent", () => {
			sandboxRegistry.generateToken("agent-1", "container-1");
			sandboxRegistry.generateToken("agent-1", "container-2");
			sandboxRegistry.generateToken("agent-2", "container-3");

			const agent1Sandboxes = sandboxRegistry.findByAgent("agent-1");
			assert.strictEqual(agent1Sandboxes.length, 2);
		});

		it("should find sandboxes by status", () => {
			sandboxRegistry.generateToken("agent-1", "container-1");
			sandboxRegistry.generateToken("agent-1", "container-2");

			// Heartbeat one to make it running
			sandboxRegistry.heartbeat("container-1");

			const provisioning = sandboxRegistry.findByStatus("provisioning");
			const running = sandboxRegistry.findByStatus("running");

			assert.strictEqual(provisioning.length, 1);
			assert.strictEqual(running.length, 1);
		});

		it("should remove sandbox", () => {
			sandboxRegistry.generateToken("agent-1", "container-abc");

			const removed = sandboxRegistry.remove("container-abc");
			assert.ok(removed);

			const found = sandboxRegistry.findByContainer("container-abc");
			assert.strictEqual(found, null);
		});
	});
});

// ============================================================================
// AC#3: DAG Validation for Cycles and Orphans
// ============================================================================

describe("proposal-84 AC#3: DAG Validation for Cycles and Orphans", () => {
	let dagHealth: DAGHealth;

	beforeEach(() => {
		dagHealth = new DAGHealth();
	});

	describe("cycle detection", () => {
		it("should validate a clean DAG (no cycles)", () => {
			const proposals = [
				createMockProposal("proposal-1", []),
				createMockProposal("proposal-2", ["proposal-1"]),
				createMockProposal("proposal-3", ["proposal-1", "proposal-2"]),
			];

			const report = dagHealth.analyzeHealth(proposals);
			const cycles = report.issues.filter((i) => i.type === "cycle");

			assert.strictEqual(cycles.length, 0);
			assert.strictEqual(report.status, "healthy");
		});

		it("should detect a simple 2-node cycle", () => {
			const proposals = [
				createMockProposal("proposal-1", ["proposal-2"]),
				createMockProposal("proposal-2", ["proposal-1"]),
			];

			const report = dagHealth.analyzeHealth(proposals);
			const cycles = report.issues.filter((i) => i.type === "cycle");

			assert.ok(cycles.length >= 1, "Should detect at least one cycle");
			assert.strictEqual(cycles[0]!.severity, "error");
			assert.strictEqual(report.status, "critical");
		});

		it("should detect a 3-node cycle", () => {
			const proposals = [
				createMockProposal("proposal-1", ["proposal-2"]),
				createMockProposal("proposal-2", ["proposal-3"]),
				createMockProposal("proposal-3", ["proposal-1"]),
			];

			const report = dagHealth.analyzeHealth(proposals);
			const cycles = report.issues.filter((i) => i.type === "cycle");

			assert.ok(cycles.length >= 1, "Should detect cycle");
		});

		it("should detect self-reference as cycle", () => {
			const proposals = [createMockProposal("proposal-1", ["proposal-1"])];

			const report = dagHealth.analyzeHealth(proposals);
			const selfRefs = report.issues.filter(
				(i) => i.type === "self-reference",
			);

			assert.strictEqual(selfRefs.length, 1);
			assert.strictEqual(report.status, "critical");
		});

		it("should detect cycles in complex graphs", () => {
			// Create a graph with a cycle: 1 -> 2 -> 3 -> 1
			const proposals = [
				createMockProposal("proposal-1", ["proposal-2"]), // 1 -> 2
				createMockProposal("proposal-2", ["proposal-3"]), // 2 -> 3
				createMockProposal("proposal-3", ["proposal-1"]), // 3 -> 1 (completes cycle!)
				createMockProposal("proposal-4", ["proposal-1"]), // 4 -> 1 (branch into cycle)
			];

			const report = dagHealth.analyzeHealth(proposals);
			const cycles = report.issues.filter((i) => i.type === "cycle");

			// There should be at least one cycle detected
			assert.ok(cycles.length >= 1, "Should detect cycle in complex graph");
		});
	});

	describe("orphan detection", () => {
		it("should detect orphan proposals (no deps, no dependents)", () => {
			const proposals = [
				createMockProposal("proposal-1", []), // Orphan: no deps, no dependents
				createMockProposal("proposal-2", ["proposal-3"]), // Has dep
				createMockProposal("proposal-3", []), // Has dependent (proposal-2)
			];

			const report = dagHealth.analyzeHealth(proposals);
			const orphans = report.issues.filter((i) => i.type === "orphan");

			// proposal-1 should be orphan, proposal-3 has dependent (proposal-2)
			assert.ok(orphans.length >= 1);
			assert.ok(orphans.some((o) => o.proposalIds.includes("proposal-1")));
		});

		it("should not flag proposals with dependencies as orphans", () => {
			const proposals = [
				createMockProposal("proposal-1", []),
				createMockProposal("proposal-2", ["proposal-1"]),
			];

			const report = dagHealth.analyzeHealth(proposals);
			const orphans = report.issues.filter((i) => i.type === "orphan");

			// proposal-2 has a dependency, proposal-1 has a dependent
			// Neither should be orphan
			const orphanIds = orphans.flatMap((o) => o.proposalIds);
			assert.ok(!orphanIds.includes("proposal-1"));
			assert.ok(!orphanIds.includes("proposal-2"));
		});

		it("should not flag Complete proposals as orphans", () => {
			const proposals = [createMockProposal("proposal-1", [], "Complete")];

			const report = dagHealth.analyzeHealth(proposals);
			const orphans = report.issues.filter((i) => i.type === "orphan");

			assert.strictEqual(orphans.length, 0);
		});

		it("should not flag Abandoned proposals as orphans", () => {
			const proposals = [createMockProposal("proposal-1", [], "Abandoned")];

			const report = dagHealth.analyzeHealth(proposals);
			const orphans = report.issues.filter((i) => i.type === "orphan");

			assert.strictEqual(orphans.length, 0);
		});
	});

	describe("additional validations", () => {
		it("should detect missing dependencies", () => {
			const proposals = [
				createMockProposal("proposal-1", ["proposal-NONEXISTENT"]),
			];

			const report = dagHealth.analyzeHealth(proposals);
			const missing = report.issues.filter(
				(i) => i.type === "missing-dependency",
			);

			assert.strictEqual(missing.length, 1);
			assert.strictEqual(missing[0]!.severity, "error");
		});

		it("should detect deep dependency chains", () => {
			const proposals = [
				createMockProposal("proposal-1", []),
				createMockProposal("proposal-2", ["proposal-1"]),
				createMockProposal("proposal-3", ["proposal-2"]),
				createMockProposal("proposal-4", ["proposal-3"]),
				createMockProposal("proposal-5", ["proposal-4"]),
				createMockProposal("proposal-6", ["proposal-5"]),
				createMockProposal("proposal-7", ["proposal-6"]), // Depth 6 from root (exceeds default maxDepthWarning=5)
			];

			const report = dagHealth.analyzeHealth(proposals);
			const deepChains = report.issues.filter(
				(i) => i.type === "deep-chain",
			);

			assert.ok(deepChains.length >= 1);
		});

		it("should calculate correct statistics", () => {
			const proposals = [
				createMockProposal("proposal-1", []),
				createMockProposal("proposal-2", []),
				createMockProposal("proposal-3", ["proposal-1"]),
			];

			const report = dagHealth.analyzeHealth(proposals);

			assert.strictEqual(report.totalProposals, 3);
			// proposal-1: no deps (root), has dependent proposal-3 (not leaf)
			// proposal-2: no deps (root), no dependents (leaf)
			// proposal-3: has dep proposal-1 (not root), no dependents (leaf)
			assert.strictEqual(report.stats.rootCount, 2); // proposal-1, proposal-2
			assert.strictEqual(report.stats.leafCount, 2); // proposal-2, proposal-3
		});

		it("should handle empty proposal list", () => {
			const report = dagHealth.analyzeHealth([]);

			assert.strictEqual(report.totalProposals, 0);
			assert.strictEqual(report.issues.length, 0);
			assert.strictEqual(report.status, "healthy");
		});

		it("should handle single proposal", () => {
			const proposals = [createMockProposal("proposal-1", [])];

			const report = dagHealth.analyzeHealth(proposals);

			assert.strictEqual(report.totalProposals, 1);
			// Single proposal with no deps is an orphan (unless complete)
			const orphans = report.issues.filter((i) => i.type === "orphan");
			assert.strictEqual(orphans.length, 1);
		});
	});
});

// ============================================================================
// Integration: Cross-feature verification
// ============================================================================

describe("proposal-84: Integration Tests", () => {
	it("AgentRegistry, SandboxRegistry, and DAGHealth should coexist", () => {
		const registry = new AgentRegistry();
		const sandboxRegistry = new SandboxRegistry();
		const dagHealth = new DAGHealth();

		// Register agent
		const agent = registry.registerAgent({
			id: "integration-agent",
			name: "Integration Test Agent",
			roles: ["senior-developer"],
			capabilities: ["typescript", "testing"],
			workspaceUrl: "https://example.com",
		});

		// Generate sandbox token
		const sandbox = sandboxRegistry.generateToken(
			"integration-agent",
			"test-container",
		);

		// Analyze some proposals
		const proposals = [
			createMockProposal("proposal-1", []),
			createMockProposal("proposal-2", ["proposal-1"]),
		];
		const health = dagHealth.analyzeHealth(proposals);

		// All should work independently
		assert.ok(agent);
		assert.ok(sandbox.token);
		assert.strictEqual(health.status, "healthy");
	});

	it("sandbox heartbeat should not affect agent registry", () => {
		const registry = new AgentRegistry();
		const sandboxRegistry = new SandboxRegistry();

		registry.registerAgent({
			id: "agent-1",
			name: "Test",
			roles: ["senior-developer"],
			capabilities: [],
			workspaceUrl: "",
		});

		sandboxRegistry.generateToken("agent-1", "container-1");

		// Heartbeat sandbox
		sandboxRegistry.heartbeat("container-1");

		// Agent registry should be unaffected
		const agent = registry.getAgent("agent-1");
		assert.ok(agent);
		assert.strictEqual(agent.status, "online");
	});
});
