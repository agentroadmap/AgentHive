/**
 * Tests for proposal-63: Agent Team Membership
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	AgentTeamMembership,
	formatTokenDisplay,
	generateTeamId,
	parsePoolAssignment,
} from "../../src/core/collaboration/team-membership.ts";

describe("proposal-63: Agent Team Membership", () => {
	let tempDir: string;
	let membership: AgentTeamMembership;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "team-membership-test-"));
		membership = new AgentTeamMembership(join(tempDir, "membership"), {
			baseDir: join(tempDir, "worktrees"),
		});
		await membership.initialize();
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("AC#1: Agent Registration API", () => {
		it("should register an agent with skills, role, and pool", async () => {
			const registration = await membership.registerAgent({
				agentId: "agent-alice",
				skills: ["typescript", "react", "testing"],
				roleAssignment: "developer",
				poolAssignment: "frontend",
			});

			assert.ok(registration.registrationId);
			assert.equal(registration.agentId, "agent-alice");
			assert.deepEqual(registration.skills, ["typescript", "react", "testing"]);
			assert.equal(registration.roleAssignment, "developer");
			assert.equal(registration.poolAssignment, "frontend");
			assert.equal(registration.status, "pending");
			assert.ok(registration.registeredAt);
			assert.ok(registration.agentToken);
			assert.ok(registration.tokenHash);
		});

		it("should reject duplicate registrations for same agent and pool", async () => {
			await assert.rejects(async () => {
				await membership.registerAgent({
					agentId: "agent-alice",
					skills: ["typescript"],
					roleAssignment: "developer",
					poolAssignment: "frontend",
				});
			}, /already registered/);
		});

		it("should allow same agent in different pools", async () => {
			const registration = await membership.registerAgent({
				agentId: "agent-alice",
				skills: ["typescript"],
				roleAssignment: "reviewer",
				poolAssignment: "backend",
			});

			assert.ok(registration.registrationId);
			assert.equal(registration.poolAssignment, "backend");
		});

		it("should activate a pending registration", async () => {
			const registration = await membership.registerAgent({
				agentId: "agent-bob",
				skills: ["python", "testing"],
				roleAssignment: "tester",
				poolAssignment: "qa",
			});

			const activated = await membership.activateRegistration(
				registration.registrationId,
			);

			assert.equal(activated.status, "active");
			assert.ok(activated.activatedAt);

			// Profile should also be active
			const profile = membership.getProfile("agent-bob");
			assert.equal(profile?.status, "active");
		});
	});

	describe("AC#2: Token Authentication", () => {
		let agentToken: string;

		before(async () => {
			const registration = await membership.registerAgent({
				agentId: "agent-charlie",
				skills: ["typescript"],
				roleAssignment: "developer",
				poolAssignment: "auth-test",
			});
			agentToken = registration.agentToken!;

			await membership.activateRegistration(registration.registrationId);
		});

		it("should verify valid tokens", () => {
			const isValid = membership.verifyToken("agent-charlie", agentToken);
			assert.equal(isValid, true);
		});

		it("should reject invalid tokens", () => {
			const isValid = membership.verifyToken("agent-charlie", "invalid-token");
			assert.equal(isValid, false);
		});

		it("should reject tokens for non-existent agents", () => {
			const isValid = membership.verifyToken("non-existent", agentToken);
			assert.equal(isValid, false);
		});

		it("should regenerate tokens", async () => {
			const registration = membership.getRegistrationByAgent("agent-charlie");
			assert.ok(registration);

			const newToken = await membership.regenerateToken(
				registration.registrationId,
			);
			assert.ok(newToken);
			assert.notEqual(newToken, agentToken);

			// Old token should fail
			const oldValid = membership.verifyToken("agent-charlie", agentToken);
			assert.equal(oldValid, false);

			// New token should work
			const newValid = membership.verifyToken("agent-charlie", newToken);
			assert.equal(newValid, true);
		});
	});

	describe("AC#3: Workspace Assignment", () => {
		before(async () => {
			// Ensure we have an active agent
			const registration = await membership.registerAgent({
				agentId: "agent-diana",
				skills: ["typescript", "react"],
				roleAssignment: "developer",
				poolAssignment: "workspace-pool",
			});
			await membership.activateRegistration(registration.registrationId);
		});

		it("should assign pool-branch and worktree-path", async () => {
			const workspace = await membership.assignWorkspace("agent-diana");

			assert.ok(workspace.assignmentId);
			assert.equal(workspace.poolBranch, "pool/workspace-pool/agent-diana");
			assert.ok(workspace.worktreePath.includes("agent-diana"));
			assert.equal(workspace.status, "provisioning");
		});

		it("should prevent duplicate workspace assignment", async () => {
			await assert.rejects(async () => {
				await membership.assignWorkspace("agent-diana");
			}, /already has workspace/);
		});

		it("should include git remote when specified", async () => {
			// Register a new agent for this test
			const registration = await membership.registerAgent({
				agentId: "agent-eve",
				skills: ["typescript"],
				roleAssignment: "developer",
				poolAssignment: "remote-pool",
			});
			await membership.activateRegistration(registration.registrationId);

			const workspace = await membership.assignWorkspace("agent-eve", {
				gitRemote: "https://github.com/example/repo.git",
			});

			assert.equal(workspace.gitRemote, "https://github.com/example/repo.git");
		});
	});

	describe("AC#4: Workspace Provisioning", () => {
		let assignmentId: string;

		before(async () => {
			// Setup agent with workspace
			const registration = await membership.registerAgent({
				agentId: "agent-frank",
				skills: ["typescript"],
				roleAssignment: "developer",
				poolAssignment: "provision-pool",
			});
			await membership.activateRegistration(registration.registrationId);

			const workspace = await membership.assignWorkspace("agent-frank");
			assignmentId = workspace.assignmentId;
		});

		it("should provision workspace with MCP config", async () => {
			const workspace = await membership.provisionWorkspace(assignmentId);

			assert.equal(workspace.status, "ready");
			assert.ok(workspace.provisionedAt);
			assert.ok(workspace.mcpConfigPath);
			assert.ok(workspace.soulMdPath);
		});

		it("should create SOUL.md with role context", async () => {
			// Check if SOUL.md was created
			const profile = membership.getProfile("agent-frank");
			assert.ok(profile?.workspace?.soulMdPath);
			const soulMdPath = profile?.workspace?.soulMdPath;
			assert.ok(soulMdPath);

			// Read the SOUL.md content
			const soulContent = await import("node:fs/promises").then((fs) =>
				fs.readFile(soulMdPath, "utf-8"),
			);

			assert.ok(soulContent.includes("agent-frank"));
			assert.ok(soulContent.includes("developer"));
			assert.ok(soulContent.includes("provision-pool"));
		});

		it("should accept custom SOUL.md content", async () => {
			// Register new agent
			const registration = await membership.registerAgent({
				agentId: "agent-grace",
				skills: ["typescript"],
				roleAssignment: "lead",
				poolAssignment: "custom-pool",
			});
			await membership.activateRegistration(registration.registrationId);

			const workspace = await membership.assignWorkspace("agent-grace");
			const provisioned = await membership.provisionWorkspace(
				workspace.assignmentId,
				{
					soulContent: "# Custom Soul\n\nThis is a custom workspace.",
				},
			);

			assert.equal(provisioned.status, "ready");
		});
	});

	describe("AC#5: Registration Events", () => {
		it("should record registration events", () => {
			const events = membership.getEvents({ type: "registered" });
			assert.ok(events.length >= 1);

			const event = events[0]!;
			assert.ok(event.eventId);
			assert.ok(event.agentId);
			assert.ok(event.registrationId);
			assert.ok(event.timestamp);
			assert.ok(event.details);
		});

		it("should record activation events", () => {
			const events = membership.getEvents({ type: "activated" });
			assert.ok(events.length >= 1);
		});

		it("should record workspace provisioning events", () => {
			const events = membership.getEvents({ type: "workspace_provisioned" });
			assert.ok(events.length >= 1);
		});

		it("should filter events by agent", async () => {
			// Register a specific agent for this test
			await membership.registerAgent({
				agentId: "agent-events",
				skills: ["typescript"],
				roleAssignment: "developer",
				poolAssignment: "events-pool",
			});

			const events = membership.getEvents({ agentId: "agent-events" });
			assert.ok(events.length >= 1);
			assert.ok(events.every((e) => e.agentId === "agent-events"));
		});

		it("should filter events by time", () => {
			const since = new Date(Date.now() - 3600000).toISOString();
			const events = membership.getEvents({ since });

			for (const event of events) {
				assert.ok(event.timestamp >= since);
			}
		});

		it("should support limiting results", () => {
			const events = membership.getEvents({ limit: 3 });
			assert.ok(events.length <= 3);
		});
	});

	describe("AC#6: Agent Deregistration", () => {
		it("should deregister an agent and release workspace", async () => {
			// Setup agent with workspace
			const registration = await membership.registerAgent({
				agentId: "agent-henry",
				skills: ["typescript"],
				roleAssignment: "developer",
				poolAssignment: "dereg-pool",
			});
			await membership.activateRegistration(registration.registrationId);

			const workspace = await membership.assignWorkspace("agent-henry");
			await membership.provisionWorkspace(workspace.assignmentId);

			// Deregister
			const result = await membership.deregisterAgent(
				"agent-henry",
				"Project completed",
			);

			assert.equal(result.registration.status, "deregistered");
			assert.ok(result.registration.deregisteredAt);
			assert.equal(
				result.registration.metadata.deregisterReason,
				"Project completed",
			);

			// Workspace should be released
			assert.equal(result.workspace?.status, "released");
			assert.ok(result.workspace?.releasedAt);

			// Profile should be deregistered
			const profile = membership.getProfile("agent-henry");
			assert.equal(profile?.status, "deregistered");
		});

		it("should record deregistration event", () => {
			const events = membership.getEvents({
				agentId: "agent-henry",
				type: "deregistered",
			});
			assert.ok(events.length >= 1);
			assert.ok(events[0]?.details.includes("Project completed"));
		});

		it("should reject deregistration of non-existent agent", async () => {
			await assert.rejects(async () => {
				await membership.deregisterAgent("non-existent");
			}, /No active registration found/);
		});
	});

	describe("AC#7: Team Roster", () => {
		before(async () => {
			// Setup multiple agents
			const agents = ["agent-i1", "agent-i2", "agent-i3"];
			for (const agentId of agents) {
				try {
					const registration = await membership.registerAgent({
						agentId,
						skills: ["typescript"],
						roleAssignment: "developer",
						poolAssignment: "roster-pool",
					});
					await membership.activateRegistration(registration.registrationId);
				} catch {
					// Already registered
				}
			}
		});

		it("should create and populate team roster", () => {
			const roster = membership.getTeamRoster("team-alpha", "Team Alpha");

			assert.equal(roster.teamId, "team-alpha");
			assert.equal(roster.teamName, "Team Alpha");
			assert.ok(Array.isArray(roster.entries));
		});

		it("should add agents to roster", () => {
			const entry = membership.addToRoster("team-alpha", "agent-i1");

			assert.equal(entry.agentId, "agent-i1");
			assert.equal(entry.role, "developer");
			assert.equal(entry.pool, "roster-pool");
			assert.ok(entry.joinedAt);
		});

		it("should prevent duplicate roster entries", () => {
			assert.throws(() => {
				membership.addToRoster("team-alpha", "agent-i1");
			}, /already in roster/);
		});

		it("should query roster by role", () => {
			// Add another agent with different role
			membership.addToRoster("team-alpha", "agent-i2");

			const developers = membership.queryRoster({
				teamId: "team-alpha",
				role: "developer",
			});

			assert.ok(developers.length >= 2);
			assert.ok(developers.every((e) => e.role === "developer"));
		});

		it("should query roster by pool", () => {
			const poolAgents = membership.queryRoster({
				teamId: "team-alpha",
				pool: "roster-pool",
			});

			assert.ok(poolAgents.length >= 2);
			assert.ok(poolAgents.every((e) => e.pool === "roster-pool"));
		});

		it("should remove agents from roster", () => {
			// First add agent-i3 to the roster
			membership.addToRoster("team-alpha", "agent-i3");
			const result = membership.removeFromRoster("team-alpha", "agent-i3");
			assert.equal(result, true);

			const roster = membership.getFullRoster("team-alpha");
			assert.ok(!roster?.entries.some((e) => e.agentId === "agent-i3"));
		});

		it("should get full roster details", () => {
			const roster = membership.getFullRoster("team-alpha");

			assert.ok(roster);
			assert.equal(roster.teamId, "team-alpha");
			assert.ok(roster.lastUpdated);
		});
	});

	describe("Statistics", () => {
		it("should provide accurate statistics", () => {
			const stats = membership.getStats();

			assert.ok(stats.totalRegistrations >= 8);
			assert.ok(stats.activeAgents >= 5);
			assert.ok(stats.totalWorkspaces >= 3);
			assert.ok(stats.totalTeams >= 1);
			assert.ok(stats.totalEvents >= 10);
		});
	});

	describe("Helpers", () => {
		it("should parse pool assignments", () => {
			const parsed1 = parsePoolAssignment("frontend");
			assert.equal(parsed1.pool, "frontend");
			assert.equal(parsed1.subpool, undefined);

			const parsed2 = parsePoolAssignment("team-alpha/frontend");
			assert.equal(parsed2.pool, "team-alpha");
			assert.equal(parsed2.subpool, "frontend");
		});

		it("should format token display", () => {
			const longToken = "abcdefghijklmnop".repeat(2);
			const formatted = formatTokenDisplay(longToken);
			assert.equal(formatted.length, 11); // 8 chars + "..."
			assert.ok(formatted.endsWith("..."));
		});

		it("should generate team IDs from names", () => {
			assert.equal(generateTeamId("Team Alpha"), "team-alpha");
			assert.equal(generateTeamId("My Project!"), "my-project");
			assert.equal(generateTeamId("  Spaces  "), "spaces");
		});
	});
});
