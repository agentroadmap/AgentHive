/**
 * Tests for proposal-63: Agent Team Membership
 *
 * AC#1: Agents can discover teams for a given proposal
 * AC#2: Agents can join teams (with capacity management)
 * AC#3: Team membership status tracked (active/inactive/retired)
 * AC#4: Agents can query their team memberships across all proposals
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	type AgentProfile,
	AgentTeamMembership,
} from "../../src/core/collaboration/agent-team-membership.ts";
import type {
	Team,
	TeamMember,
} from "../../src/core/collaboration/dynamic-team-builder.ts";

describe("proposal-63: Agent Team Membership", () => {
	let manager: AgentTeamMembership;

	beforeEach(() => {
		manager = new AgentTeamMembership({ maxTeamsPerAgent: 5 });
	});

	// Helper to create a mock team
	function createMockTeam(
		teamId: string,
		proposalId: string,
		members?: TeamMember[],
	): Team {
		return {
			teamId,
			proposalId,
			status: "forming",
			members: members ?? [],
			ownerId: "agent-owner",
			coordinationStrategy: "owner-only",
			leaseChain: [],
			proposalIds: [],
			createdAt: new Date().toISOString(),
			description: `Team for ${proposalId}`,
			capacity: members?.reduce((sum, m) => sum + m.capacity, 0) ?? 0,
		};
	}

	// Helper to create an agent profile
	function createAgentProfile(
		agentId: string,
		options?: Partial<AgentProfile>,
	): AgentProfile {
		return {
			agentId,
			displayName: agentId,
			skills: ["typescript", "testing"],
			usedCapacity: 0,
			maxCapacity: 100,
			availability: "available",
			activeTeamCount: 0,
			avgContribution: 0,
			lastSeen: new Date().toISOString(),
			...options,
		};
	}

	// ─── AC#1: Discover Teams for a Given Proposal ────────────────────

	describe("AC#1: Agents can discover teams for a given proposal", () => {
		it("discovers teams for a proposal", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.registerAgent(createAgentProfile("agent-alpha"));

			const discoveries = manager.discoverTeams("agent-alpha", "proposal-42");

			assert.equal(discoveries.length, 1);
			assert.equal(discoveries[0]?.team.teamId, "team-1");
			assert.ok(discoveries[0]?.relevance >= 0);
			assert.ok(discoveries[0]?.relevance <= 1);
		});

		it("returns empty for unknown proposal", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const discoveries = manager.discoverTeams("agent-alpha", "proposal-99");

			assert.equal(discoveries.length, 0);
		});

		it("sorts by relevance", () => {
			const team1 = createMockTeam("team-1", "proposal-42");
			const team2 = createMockTeam("team-2", "proposal-42");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.registerAgent(
				createAgentProfile("agent-alpha", {
					skills: ["typescript"],
				}),
			);

			const discoveries = manager.discoverTeams("agent-alpha", "proposal-42");

			assert.ok(discoveries.length >= 2);
			// First should have higher relevance
			assert.ok(discoveries[0]?.relevance >= discoveries[1].relevance);
		});

		it("filters by minimum relevance", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.registerAgent(createAgentProfile("agent-alpha"));

			const discoveries = manager.discoverTeams("agent-alpha", "proposal-42", {
				minRelevance: 0.9,
			});

			assert.ok(discoveries.every((d) => d.relevance >= 0.9));
		});

		it("reports available roles", () => {
			const existingMember: TeamMember = {
				memberId: "agent-owner",
				displayName: "Owner",
				role: "owner",
				status: "accepted",
				invitedAt: new Date().toISOString(),
				skills: [],
				capacity: 50,
			};

			const team = createMockTeam("team-1", "proposal-42", [existingMember]);
			manager.registerTeam(team);

			const discoveries = manager.discoverTeams("agent-alpha", "proposal-42");

			assert.ok(discoveries[0]?.availableRoles.includes("contributor"));
		});

		it("registers and unregisters teams", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);
			assert.equal(manager.getRegisteredTeams().length, 1);

			manager.unregisterTeam("team-1");
			assert.equal(manager.getRegisteredTeams().length, 0);
		});
	});

	// ─── AC#2: Agents Can Join Teams (Capacity Management) ─────────

	describe("AC#2: Agents can join teams", () => {
		it("joins a team successfully", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);
			manager.registerAgent(createAgentProfile("agent-alpha"));

			const membership = manager.joinTeam("agent-alpha", "team-1");

			assert.ok(membership.membershipId);
			assert.equal(membership.agentId, "agent-alpha");
			assert.equal(membership.teamId, "team-1");
			assert.equal(membership.status, "active");
			assert.ok(membership.joinedAt);
		});

		it("prevents joining an unknown team", () => {
			assert.throws(
				() => manager.joinTeam("agent-alpha", "team-nonexistent"),
				/Team not found/,
			);
		});

		it("prevents joining the same team twice", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");

			assert.throws(
				() => manager.joinTeam("agent-alpha", "team-1"),
				/already a member/,
			);
		});

		it("enforces capacity limits", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			// Register agent with low capacity
			manager.registerAgent(
				createAgentProfile("agent-alpha", {
					usedCapacity: 90,
					maxCapacity: 100,
				}),
			);

			assert.throws(
				() => manager.joinTeam("agent-alpha", "team-1", { capacity: 20 }),
				/Insufficient capacity/,
			);
		});

		it("enforces max teams limit", () => {
			const maxOneManager = new AgentTeamMembership({ maxTeamsPerAgent: 1 });

			const team1 = createMockTeam("team-1", "proposal-1");
			const team2 = createMockTeam("team-2", "proposal-2");
			maxOneManager.registerTeam(team1);
			maxOneManager.registerTeam(team2);

			maxOneManager.joinTeam("agent-alpha", "team-1");

			assert.throws(
				() => maxOneManager.joinTeam("agent-alpha", "team-2"),
				/complete max team limit/,
			);
		});

		it("leaves a team", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);
			manager.registerAgent(createAgentProfile("agent-alpha"));

			manager.joinTeam("agent-alpha", "team-1");
			const left = manager.leaveTeam("agent-alpha", "team-1", "Completed work");

			assert.equal(left.status, "retired");
			assert.ok(left.leftAt);
			assert.equal(left.leaveReason, "Completed work");
		});

		it("prevents leaving a team twice", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");
			manager.leaveTeam("agent-alpha", "team-1");

			assert.throws(
				() => manager.leaveTeam("agent-alpha", "team-1"),
				/has already left/,
			);
		});

		it("updates agent capacity when joining/leaving", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const agent = createAgentProfile("agent-alpha", { usedCapacity: 0 });
			manager.registerAgent(agent);

			manager.joinTeam("agent-alpha", "team-1", { capacity: 30 });
			assert.equal(agent.usedCapacity, 30);

			manager.leaveTeam("agent-alpha", "team-1");
			assert.equal(agent.usedCapacity, 0);
		});

		it("supports custom capacity per team", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const membership = manager.joinTeam("agent-alpha", "team-1", {
				capacity: 50,
			});

			assert.equal(membership.capacity, 50);
		});

		it("supports custom role assignment", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const membership = manager.joinTeam("agent-alpha", "team-1", {
				role: "advisor",
			});

			assert.equal(membership.role, "advisor");
		});
	});

	// ─── AC#3: Team Membership Status Tracked ──────────────────────

	describe("AC#3: Team membership status tracked", () => {
		it("starts as active", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const membership = manager.joinTeam("agent-alpha", "team-1");

			assert.equal(membership.status, "active");
		});

		it("sets membership to inactive", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");
			const inactive = manager.setInactive("agent-alpha", "team-1");

			assert.equal(inactive.status, "inactive");
		});

		it("prevents setting non-active to inactive", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");
			manager.leaveTeam("agent-alpha", "team-1");

			assert.throws(
				() => manager.setInactive("agent-alpha", "team-1"),
				/Cannot set inactive/,
			);
		});

		it("reactivates an inactive membership", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);
			manager.registerAgent(createAgentProfile("agent-alpha"));

			manager.joinTeam("agent-alpha", "team-1");
			manager.setInactive("agent-alpha", "team-1");
			const active = manager.setActive("agent-alpha", "team-1");

			assert.equal(active.status, "active");
		});

		it("prevents reactivating if capacity insufficient", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const agent = createAgentProfile("agent-alpha", {
				usedCapacity: 0,
				maxCapacity: 100,
			});
			manager.registerAgent(agent);

			manager.joinTeam("agent-alpha", "team-1", { capacity: 80 });
			manager.setInactive("agent-alpha", "team-1");

			// Use up capacity elsewhere
			agent.usedCapacity = 70;

			assert.throws(
				() => manager.setActive("agent-alpha", "team-1"),
				/Insufficient capacity/,
			);
		});

		it("updates capacity on a membership", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);
			manager.registerAgent(createAgentProfile("agent-alpha"));

			manager.joinTeam("agent-alpha", "team-1", { capacity: 30 });
			const updated = manager.updateCapacity("agent-alpha", "team-1", 50);

			assert.equal(updated.capacity, 50);
		});

		it("prevents over-capacity update", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			const agent = createAgentProfile("agent-alpha", {
				usedCapacity: 30,
				maxCapacity: 50,
			});
			manager.registerAgent(agent);

			manager.joinTeam("agent-alpha", "team-1", { capacity: 20 });

			assert.throws(
				() => manager.updateCapacity("agent-alpha", "team-1", 40),
				/Insufficient capacity/,
			);
		});

		it("tracks contribution metrics", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");

			const updated = manager.updateContributions("agent-alpha", "team-1", {
				tasksCompleted: 5,
				reviewsProvided: 3,
				commits: 10,
			});

			assert.equal(updated.contributions.tasksCompleted, 5);
			assert.equal(updated.contributions.reviewsProvided, 3);
			assert.equal(updated.contributions.commits, 10);
		});

		it("gets membership history", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1");
			manager.leaveTeam("agent-alpha", "team-1", "Done");

			const history = manager.getMembershipHistory("agent-alpha", "team-1");
			assert.ok(history.length >= 2);

			const events = history.map((h) => h.event);
			assert.ok(events.includes("joined"));
			assert.ok(events.includes("left"));
		});

		it("gets team composition report", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1", { role: "owner" });
			manager.joinTeam("agent-beta", "team-1", { role: "contributor" });
			manager.joinTeam("agent-gamma", "team-1", { role: "contributor" });

			const composition = manager.getTeamComposition("team-1");

			assert.ok(composition);
			assert.equal(composition.activeCount, 3);
			assert.equal(composition.totalCount, 3);
			assert.equal(composition.roles.owner, 1);
			assert.equal(composition.roles.contributor, 2);
		});
	});

	// ─── AC#4: Query Team Memberships Across All Proposals ────────────

	describe("AC#4: Query team memberships across all proposals", () => {
		it("gets all memberships for an agent", () => {
			const team1 = createMockTeam("team-1", "proposal-1");
			const team2 = createMockTeam("team-2", "proposal-2");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.joinTeam("agent-alpha", "team-1");
			manager.joinTeam("agent-alpha", "team-2");

			const memberships = manager.getAgentMemberships("agent-alpha");
			assert.equal(memberships.length, 2);
		});

		it("gets only active memberships for an agent", () => {
			const team1 = createMockTeam("team-1", "proposal-1");
			const team2 = createMockTeam("team-2", "proposal-2");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.joinTeam("agent-alpha", "team-1");
			manager.joinTeam("agent-alpha", "team-2");
			manager.leaveTeam("agent-alpha", "team-2");

			const active = manager.getAgentActiveMemberships("agent-alpha");
			assert.equal(active.length, 1);
			assert.equal(active[0].teamId, "team-1");
		});

		it("gets agent workload summary", () => {
			const team1 = createMockTeam("team-1", "proposal-1");
			const team2 = createMockTeam("team-2", "proposal-2");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.registerAgent(createAgentProfile("agent-alpha"));
			manager.joinTeam("agent-alpha", "team-1", { capacity: 30 });
			manager.joinTeam("agent-alpha", "team-2", { capacity: 20 });

			const workload = manager.getAgentWorkload("agent-alpha");

			assert.equal(workload.activeTeams, 2);
			assert.equal(workload.totalCapacityUsed, 50);
			assert.equal(workload.availableCapacity, 50);
			assert.equal(workload.teams.length, 2);
		});

		it("gets team members list", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1", { role: "owner" });
			manager.joinTeam("agent-beta", "team-1", { role: "contributor" });

			const members = manager.getTeamMembers("team-1");

			assert.equal(members.length, 2);
			assert.ok(members.some((m) => m.agentId === "agent-alpha"));
			assert.ok(members.some((m) => m.agentId === "agent-beta"));
		});

		it("gets memberships by proposal", () => {
			const team1 = createMockTeam("team-1", "proposal-42");
			const team2 = createMockTeam("team-2", "proposal-42");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.joinTeam("agent-alpha", "team-1");
			manager.joinTeam("agent-beta", "team-2");

			const proposalMemberships = manager.getMemberships({
				proposalId: "proposal-42",
			});
			assert.equal(proposalMemberships.length, 2);
		});

		it("gets memberships by role", () => {
			const team = createMockTeam("team-1", "proposal-42");
			manager.registerTeam(team);

			manager.joinTeam("agent-alpha", "team-1", { role: "owner" });
			manager.joinTeam("agent-beta", "team-1", { role: "contributor" });
			manager.joinTeam("agent-gamma", "team-1", { role: "advisor" });

			const contributors = manager.getMemberships({ role: "contributor" });
			assert.equal(contributors.length, 1);
			assert.equal(contributors[0].agentId, "agent-beta");
		});

		it("finds agents with available capacity", () => {
			manager.registerAgent(
				createAgentProfile("agent-alpha", {
					usedCapacity: 20,
					maxCapacity: 100,
					availability: "available",
				}),
			);

			manager.registerAgent(
				createAgentProfile("agent-beta", {
					usedCapacity: 90,
					maxCapacity: 100,
					availability: "available",
				}),
			);

			manager.registerAgent(
				createAgentProfile("agent-gamma", {
					usedCapacity: 50,
					maxCapacity: 100,
					availability: "unavailable",
				}),
			);

			const available = manager.findAvailableAgents({ minCapacity: 50 });

			assert.equal(available.length, 1);
			assert.equal(available[0].agentId, "agent-alpha");
		});

		it("finds agents by skills", () => {
			manager.registerAgent(
				createAgentProfile("agent-alpha", {
					skills: ["typescript", "react", "testing"],
					availability: "available",
				}),
			);

			manager.registerAgent(
				createAgentProfile("agent-beta", {
					skills: ["python", "django"],
					availability: "available",
				}),
			);

			const found = manager.findAvailableAgents({
				requiredSkills: ["typescript"],
			});

			assert.equal(found.length, 1);
			assert.equal(found[0].agentId, "agent-alpha");
		});

		it("provides membership statistics", () => {
			const team1 = createMockTeam("team-1", "proposal-1");
			const team2 = createMockTeam("team-2", "proposal-2");
			manager.registerTeam(team1);
			manager.registerTeam(team2);

			manager.joinTeam("agent-alpha", "team-1");
			manager.joinTeam("agent-beta", "team-1");
			manager.joinTeam("agent-alpha", "team-2");

			const stats = manager.getStats();

			assert.equal(stats.totalMemberships, 3);
			assert.equal(stats.activeMemberships, 3);
			assert.equal(stats.totalAgents, 2);
			assert.equal(stats.totalTeams, 2);
			assert.ok(stats.avgTeamsPerAgent > 0);
			assert.ok(stats.avgMembersPerTeam > 0);
		});
	});
});
