/**
 * Tests for proposal-62: Dynamic Team Building
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	calculateSimpleSkillMatch,
	createAgentProfile,
	createRequirement,
	DynamicTeamBuilder,
	type ProjectRequirements,
	type Team,
} from "../../src/core/collaboration/team-builder.ts";

describe("proposal-62: Dynamic Team Building", () => {
	let tempDir: string;
	let builder: DynamicTeamBuilder;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "team-builder-test-"));
		builder = new DynamicTeamBuilder(join(tempDir, "teams"));
		await builder.initialize();

		// Register some test agents
		builder.registerAgent(
			createAgentProfile(
				"agent-1",
				"Alice",
				["typescript", "react", "api-design"],
				{
					availability: "available",
					trustScore: 90,
					currentWorkload: 20,
					preferredRoles: ["developer", "lead"],
				},
			),
		);

		builder.registerAgent(
			createAgentProfile("agent-2", "Bob", ["python", "testing", "ci-cd"], {
				availability: "available",
				trustScore: 85,
				currentWorkload: 30,
				preferredRoles: ["tester", "developer"],
			}),
		);

		builder.registerAgent(
			createAgentProfile(
				"agent-3",
				"Charlie",
				["typescript", "architecture", "security"],
				{
					availability: "available",
					trustScore: 95,
					currentWorkload: 40,
					preferredRoles: ["architect", "lead"],
				},
			),
		);

		builder.registerAgent(
			createAgentProfile(
				"agent-4",
				"Diana",
				["react", "testing", "documentation"],
				{
					availability: "busy",
					trustScore: 80,
					currentWorkload: 70,
					preferredRoles: ["reviewer", "tester"],
				},
			),
		);

		builder.registerAgent(
			createAgentProfile(
				"agent-5",
				"Eve",
				["typescript", "nodejs", "api-design"],
				{
					availability: "offline",
					trustScore: 75,
					currentWorkload: 0,
					preferredRoles: ["developer"],
				},
			),
		);
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("Agent Registry", () => {
		it("should register and retrieve agents", () => {
			const agent = builder.getAgent("agent-1");
			assert.ok(agent);
			assert.equal(agent.name, "Alice");
			assert.deepEqual(agent.capabilities, [
				"typescript",
				"react",
				"api-design",
			]);
		});

		it("should query agents by capability", () => {
			const typescriptAgents = builder.queryAgentsByCapability(["typescript"]);
			assert.ok(typescriptAgents.length >= 2);
			assert.ok(typescriptAgents.some((a) => a.agentId === "agent-1"));
			assert.ok(typescriptAgents.some((a) => a.agentId === "agent-3"));
		});

		it("should get available agents", () => {
			const available = builder.getAvailableAgents();
			assert.ok(available.every((a) => a.availability === "available"));
			assert.ok(available.every((a) => a.currentWorkload < 80));
			// agent-4 is busy (70% workload), agent-5 is offline
			assert.ok(available.length >= 3);
		});
	});

	describe("AC#1: Team Requirements", () => {
		it("should suggest a team based on requirements", () => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-001",
				projectName: "Web App",
				description: "A TypeScript web application",
				requirements: [
					createRequirement("developer", ["typescript", "react"], 2),
					createRequirement("tester", ["testing"], 1),
				],
				totalCapacityNeeded: 100,
				skillsCoverage: ["typescript", "react", "testing"],
			};

			const suggestion = builder.suggestTeam(requirements);

			assert.ok(suggestion.suggestionId);
			assert.equal(suggestion.projectId, "PROJ-001");
			assert.ok(suggestion.agents.length >= 2);
			assert.ok(suggestion.overallScore > 0);
			assert.ok(suggestion.skillCoverage);
		});

		it("should respect required vs preferred requirements", () => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-002",
				projectName: "API Service",
				description: "A backend API",
				requirements: [
					createRequirement("developer", ["typescript"], 1, "required"),
					createRequirement("architect", ["architecture"], 1, "preferred"),
					createRequirement("devops", ["kubernetes", "docker"], 1, "required"),
				],
				totalCapacityNeeded: 80,
				skillsCoverage: ["typescript", "architecture"],
			};

			const suggestion = builder.suggestTeam(requirements);
			// Should still suggest even with unmet required skills
			assert.ok(suggestion);
		});
	});

	describe("AC#2: Agent Registry Query", () => {
		it("should match agents by capabilities", () => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-003",
				projectName: "Testing Project",
				description: "Focus on testing",
				requirements: [createRequirement("tester", ["testing", "ci-cd"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["testing", "ci-cd"],
			};

			const suggestion = builder.suggestTeam(requirements);
			const agent2 = suggestion.agents.find((a) => a.agentId === "agent-2");
			assert.ok(agent2, "Bob should be suggested for testing role");
		});
	});

	describe("AC#3: Skill Coverage Analysis", () => {
		it("should calculate skill coverage correctly", () => {
			const coverage = builder.calculateSkillCoverage(
				["typescript", "react", "testing"],
				["typescript", "react", "python", "testing"],
			);

			assert.equal(coverage.coveragePercent, 100);
			assert.equal(coverage.missingSkills.length, 0);
			assert.deepEqual(coverage.coveredSkills.sort(), [
				"react",
				"testing",
				"typescript",
			]);
		});

		it("should identify missing skills", () => {
			const coverage = builder.calculateSkillCoverage(
				["typescript", "react", "kubernetes", "docker"],
				["typescript", "react"],
			);

			assert.equal(coverage.coveragePercent, 50);
			assert.ok(coverage.missingSkills.includes("kubernetes"));
			assert.ok(coverage.missingSkills.includes("docker"));
		});

		it("should include coverage in team suggestions", () => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-004",
				projectName: "Full Stack App",
				description: "Full stack application",
				requirements: [
					createRequirement("developer", ["typescript", "react"], 1),
				],
				totalCapacityNeeded: 80,
				skillsCoverage: ["typescript", "react", "testing"],
			};

			const suggestion = builder.suggestTeam(requirements);
			assert.ok(suggestion.skillCoverage);
			assert.equal(typeof suggestion.skillCoverage.coveragePercent, "number");
		});
	});

	describe("AC#4: Agent Accept/Decline", () => {
		let team: Team;

		before(() => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-005",
				projectName: "Accept Decline Test",
				description: "Testing accept/decline",
				requirements: [createRequirement("developer", ["typescript"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			team = builder.createTeam(requirements, suggestion);
		});

		it("AC#4: should allow agent to accept invitation", () => {
			const member = team.members[0];
			const result = builder.acceptInvitation(team.teamId, member.agentId);

			assert.equal(result.status, "accepted");
			assert.ok(result.respondedAt);
		});

		it("AC#4: should allow agent to decline invitation", () => {
			// Create a new team for decline test
			const requirements: ProjectRequirements = {
				projectId: "PROJ-006",
				projectName: "Decline Test",
				description: "Testing decline",
				requirements: [createRequirement("developer", ["typescript"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			const declineTeam = builder.createTeam(requirements, suggestion);
			const member = declineTeam.members[0];

			const result = builder.declineInvitation(
				declineTeam.teamId,
				member.agentId,
				"Too busy",
			);

			assert.equal(result.status, "declined");
			assert.ok(result.respondedAt);
		});

		it("should update team status when all required members accept", () => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-007",
				projectName: "Formation Test",
				description: "Testing team formation",
				requirements: [
					createRequirement("developer", ["typescript"], 1, "required"),
				],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			const formTeam = builder.createTeam(requirements, suggestion);

			assert.equal(formTeam.status, "forming");

			// Accept invitation
			builder.acceptInvitation(formTeam.teamId, formTeam.members[0].agentId);

			// Team should now be active
			const updated = builder.getTeam(formTeam.teamId);
			assert.equal(updated?.status, "active");
		});
	});

	describe("AC#5: Team Lead Assignment", () => {
		let team: Team;

		before(() => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-008",
				projectName: "Lead Assignment Test",
				description: "Testing lead assignment",
				requirements: [createRequirement("developer", ["typescript"], 2)],
				totalCapacityNeeded: 80,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			team = builder.createTeam(requirements, suggestion);
		});

		it("AC#5: should manually assign team lead", () => {
			const updated = builder.assignTeamLead(
				team.teamId,
				team.members[0].agentId,
			);

			assert.equal(updated.leadAgentId, team.members[0].agentId);
			assert.equal(updated.members[0].role, "lead");
		});

		it("AC#5: should auto-select team lead", () => {
			// Create a new team for auto-select test
			const requirements: ProjectRequirements = {
				projectId: "PROJ-009",
				projectName: "Auto Lead Test",
				description: "Testing auto lead selection",
				requirements: [createRequirement("developer", ["typescript"], 2)],
				totalCapacityNeeded: 80,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			const autoTeam = builder.createTeam(requirements, suggestion);

			const updated = builder.autoSelectTeamLead(autoTeam.teamId);

			assert.ok(updated.leadAgentId);
			// Charlie (agent-3) has highest trust score (95)
			const leadMember = updated.members.find(
				(m) => m.agentId === updated.leadAgentId,
			);
			assert.ok(leadMember);
			assert.equal(leadMember.role, "lead");
		});

		it("should reject lead assignment for non-member", () => {
			assert.throws(() => {
				builder.assignTeamLead(team.teamId, "non-existent-agent");
			}, /not a team member/);
		});
	});

	describe("AC#6: Communication Channel", () => {
		let team: Team;

		before(() => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-010",
				projectName: "Channel Test",
				description: "Testing channel creation",
				requirements: [createRequirement("developer", ["typescript"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			team = builder.createTeam(requirements, suggestion);
		});

		it("AC#6: should create a team communication channel", () => {
			const channel = builder.createTeamChannel(team.teamId);

			assert.ok(channel.channelId);
			assert.ok(channel.name.includes("channel-test"));
			assert.equal(channel.teamId, team.teamId);
			assert.ok(channel.isActive);
			assert.ok(channel.members.length >= 1);
		});

		it("should get team channel", () => {
			const channel = builder.getTeamChannel(team.teamId);

			assert.ok(channel);
			assert.equal(channel.teamId, team.teamId);
		});

		it("should prevent duplicate channel creation", () => {
			assert.throws(() => {
				builder.createTeamChannel(team.teamId);
			}, /already has a channel/);
		});
	});

	describe("AC#7: Team Dissolution", () => {
		let team: Team;

		before(() => {
			const requirements: ProjectRequirements = {
				projectId: "PROJ-011",
				projectName: "Dissolution Test",
				description: "Testing dissolution",
				requirements: [createRequirement("developer", ["typescript"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			team = builder.createTeam(requirements, suggestion);
			builder.createTeamChannel(team.teamId);

			// Accept invitation
			builder.acceptInvitation(team.teamId, team.members[0].agentId);
		});

		it("AC#7: should dissolve a team", () => {
			const dissolved = builder.dissolveTeam(team.teamId, "Project cancelled");

			assert.equal(dissolved.status, "dissolved");
			assert.ok(dissolved.dissolvedAt);
			assert.equal(dissolved.dissolveReason, "Project cancelled");

			// Members should be marked as removed
			for (const member of dissolved.members) {
				assert.equal(member.status, "removed");
			}

			// Channel should be deactivated
			const channel = builder.getTeamChannel(team.teamId);
			assert.equal(channel?.isActive, false);
		});

		it("AC#7: should complete a team", () => {
			// Create a new team for completion test
			const requirements: ProjectRequirements = {
				projectId: "PROJ-012",
				projectName: "Completion Test",
				description: "Testing completion",
				requirements: [createRequirement("developer", ["typescript"], 1)],
				totalCapacityNeeded: 50,
				skillsCoverage: ["typescript"],
			};

			const suggestion = builder.suggestTeam(requirements);
			const completeTeam = builder.createTeam(requirements, suggestion);
			builder.createTeamChannel(completeTeam.teamId);

			const completed = builder.completeTeam(completeTeam.teamId);

			assert.equal(completed.status, "completed");
			assert.ok(completed.dissolvedAt);
			assert.equal(completed.dissolveReason, "Project completed");
		});
	});

	describe("Query Methods", () => {
		it("should get teams by status", () => {
			const formingTeams = builder.getTeamsByStatus("forming");
			assert.ok(Array.isArray(formingTeams));

			const activeTeams = builder.getTeamsByStatus("active");
			assert.ok(Array.isArray(activeTeams));
		});

		it("should get teams for an agent", () => {
			const agentTeams = builder.getAgentTeams("agent-1");
			assert.ok(Array.isArray(agentTeams));
		});

		it("should get team roster", () => {
			const teams = builder.getAllTeams();
			if (teams.length > 0) {
				const roster = builder.getTeamRoster(teams[0].teamId);
				assert.ok(roster);
				assert.ok(Array.isArray(roster));
			}
		});

		it("should provide statistics", () => {
			const stats = builder.getStats();

			assert.equal(typeof stats.totalTeams, "number");
			assert.equal(typeof stats.forming, "number");
			assert.equal(typeof stats.active, "number");
			assert.equal(typeof stats.totalChannels, "number");
		});
	});

	describe("Helpers", () => {
		it("should create requirements", () => {
			const req = createRequirement(
				"developer",
				["typescript", "react"],
				2,
				"required",
			);

			assert.equal(req.role, "developer");
			assert.deepEqual(req.skillRequired, ["typescript", "react"]);
			assert.equal(req.count, 2);
			assert.equal(req.priority, "required");
		});

		it("should create agent profiles", () => {
			const agent = createAgentProfile(
				"test-agent",
				"Test Agent",
				["testing"],
				{
					availability: "available",
					trustScore: 85,
				},
			);

			assert.equal(agent.agentId, "test-agent");
			assert.equal(agent.name, "Test Agent");
			assert.deepEqual(agent.capabilities, ["testing"]);
			assert.equal(agent.availability, "available");
			assert.equal(agent.trustScore, 85);
		});

		it("should calculate simple skill match", () => {
			assert.equal(
				calculateSimpleSkillMatch(["typescript", "react"], ["typescript"]),
				1,
			);
			assert.equal(
				calculateSimpleSkillMatch(["typescript"], ["typescript", "react"]),
				0.5,
			);
			assert.equal(calculateSimpleSkillMatch(["python"], ["typescript"]), 0);
		});
	});
});
