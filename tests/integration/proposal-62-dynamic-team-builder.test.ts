/**
 * Tests for proposal-62: Dynamic Team Building
 *
 * AC#1: Proposals evaluated for same-proposal overlap
 * AC#2: Team formed with clear roles (owner, contributor, advisor)
 * AC#3: Team members notified and can accept/decline roles
 * AC#4: Team coordination through shared lease or lease chain
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	type AgentProposal,
	AgentProposalSystem,
	createApproach,
	createComplexityEstimate,
} from "../../src/core/collaboration/agent-proposals.ts";
import { DynamicTeamBuilder } from "../../src/core/collaboration/dynamic-team-builder.ts";

describe("proposal-62: Dynamic Team Building", () => {
	let builder: DynamicTeamBuilder;
	let proposalSystem: AgentProposalSystem;

	beforeEach(() => {
		builder = new DynamicTeamBuilder();
		proposalSystem = new AgentProposalSystem();
	});

	// Helper to create proposals for testing (creates proposals directly)
	function createTestProposals(
		proposalId: string,
		count: number,
	): AgentProposal[] {
		const proposals: AgentProposal[] = [];

		for (let i = 0; i < count; i++) {
			const agentId = `agent-${String.fromCharCode(97 + i)}`;
			proposals.push({
				proposalId: `prop-${proposalId}-${agentId}`,
				targetProposalId: proposalId,
				agentId,
				title: `Proposal ${i + 1}`,
				summary: `Implementation approach ${i + 1}`,
				approach: createApproach(
					i === 0 ? "new-feature" : "incremental",
					`Approach ${i + 1} for ${proposalId}`,
					{
						filesAffected: [
							`src/core/${proposalId}.ts`,
							`src/test/${proposalId}.test.ts`,
						],
						estimatedTimeline: `${i + 1} days`,
					},
				),
				complexity: createComplexityEstimate(i === 0 ? "high" : "medium", {
					estimatedHours: 8 * (i + 1),
					confidence: 0.7,
				}),
				status: "approved" as const,
				submittedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				feedback: [],
				claimed: false,
				version: 1,
			});
		}

		return proposals;
	}

	// ─── AC#1: Proposals Evaluated for Same-Proposal Overlap ──────────

	describe("AC#1: Proposals evaluated for same-proposal overlap", () => {
		it("detects overlap for same-proposal proposals", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const overlaps = builder.evaluateOverlap(proposals);

			assert.equal(overlaps.length, 1);
			assert.equal(overlaps[0].proposalId, "proposal-42");
			assert.equal(overlaps[0].proposals.length, 3);
		});

		it("returns empty for no overlap", () => {
			const p1 = proposalSystem.submitProposal("proposal-1", "agent-a", {
				title: "P1",
				summary: "S1",
				approach: createApproach("new-feature", "A1"),
				complexity: createComplexityEstimate("low"),
			});

			const p2 = proposalSystem.submitProposal("proposal-2", "agent-b", {
				title: "P2",
				summary: "S2",
				approach: createApproach("incremental", "A2"),
				complexity: createComplexityEstimate("low"),
			});

			const overlaps = builder.evaluateOverlap([p1, p2]);

			assert.equal(overlaps.length, 0);
		});

		it("calculates similarity score", () => {
			const proposals = createTestProposals("proposal-42", 2);

			const overlaps = builder.evaluateOverlap(proposals);

			assert.ok(overlaps[0].similarity >= 0);
			assert.ok(overlaps[0].similarity <= 1);
		});

		it("suggests team size based on complexity", () => {
			const proposals = createTestProposals("proposal-42", 4);

			const overlaps = builder.evaluateOverlap(proposals);

			assert.ok(overlaps[0].suggestedTeamSize >= 2);
			assert.ok(overlaps[0].suggestedTeamSize <= 5);
		});

		it("recommends roles based on proposals", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const overlaps = builder.evaluateOverlap(proposals);

			assert.ok(overlaps[0].recommendedRoles.length > 0);
			const roles = overlaps[0].recommendedRoles.map((r) => r.role);
			assert.ok(roles.includes("owner"));
		});

		it("sorts overlaps by proposal count", () => {
			const proposal1 = createTestProposals("proposal-1", 4);
			const proposal2 = createTestProposals("proposal-2", 2);

			const overlaps = builder.evaluateOverlap([...proposal1, ...proposal2]);

			// proposal-1 has 4 proposals, proposal-2 has 2
			assert.ok(overlaps[0].proposals.length >= overlaps[1].proposals.length);
		});
	});

	// ─── AC#2: Team Formed with Clear Roles ─────────────────────────

	describe("AC#2: Team formed with clear roles", () => {
		it("forms a team from overlapping proposals", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals);

			assert.ok(team.teamId);
			assert.equal(team.proposalId, "proposal-42");
			assert.equal(team.status, "forming");
			assert.equal(team.members.length, 3);
			assert.ok(team.createdAt);
		});

		it("assigns owner role to lead proposer", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals);

			const owner = team.members.find((m) => m.role === "owner");
			assert.ok(owner);
			assert.equal(owner.memberId, team.ownerId);
		});

		it("assigns contributor roles to other proposers", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals);

			const contributors = team.members.filter((m) => m.role === "contributor");
			assert.ok(contributors.length >= 2);
		});

		it("sets coordination strategy", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals);

			assert.ok(team.coordinationStrategy);
			assert.ok(
				["owner-only", "lease-chain", "shared-lease"].includes(
					team.coordinationStrategy,
				),
			);
		});

		it("creates lease chain for multi-member teams", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals, {
				coordinationStrategy: "lease-chain",
			});

			assert.equal(team.leaseChain.length, 3);
			assert.equal(team.leaseChain[0].position, 0);
			assert.equal(team.leaseChain[1].position, 1);
		});

		it("requires at least 2 proposals", () => {
			const proposals = createTestProposals("proposal-42", 1);

			assert.throws(
				() => builder.formTeam("proposal-42", proposals),
				/Need at least 2 proposals/,
			);
		});

		it("requires all proposals to target the same proposal", () => {
			const p1 = proposalSystem.submitProposal("proposal-1", "agent-a", {
				title: "P1",
				summary: "S1",
				approach: createApproach("new-feature", "A1"),
				complexity: createComplexityEstimate("medium"),
			});
			proposalSystem.approveProposal(p1.proposalId, "reviewer-1");

			const p2 = proposalSystem.submitProposal("proposal-2", "agent-b", {
				title: "P2",
				summary: "S2",
				approach: createApproach("incremental", "A2"),
				complexity: createComplexityEstimate("medium"),
			});
			proposalSystem.approveProposal(p2.proposalId, "reviewer-1");

			assert.throws(
				() => builder.formTeam("proposal-1", [p1, p2]),
				/must target the same proposal/,
			);
		});

		it("retrieves team by ID", () => {
			const proposals = createTestProposals("proposal-42", 2);

			const formed = builder.formTeam("proposal-42", proposals);
			const retrieved = builder.getTeam(formed.teamId);

			assert.ok(retrieved);
			assert.equal(retrieved.teamId, formed.teamId);
		});

		it("queries teams with filters", () => {
			const p1 = createTestProposals("proposal-1", 2);
			const p2 = createTestProposals("proposal-2", 2);

			builder.formTeam("proposal-1", p1);
			builder.formTeam("proposal-2", p2);

			const formingTeams = builder.getTeams({ status: "forming" });
			assert.equal(formingTeams.length, 2);

			const proposal1Teams = builder.getTeams({ proposalId: "proposal-1" });
			assert.equal(proposal1Teams.length, 1);
		});

		it("tracks team capacity", () => {
			const proposals = createTestProposals("proposal-42", 3);

			const team = builder.formTeam("proposal-42", proposals);

			assert.ok(team.capacity > 0);
		});
	});

	// ─── AC#3: Team Members Notified and Can Accept/Decline ────────

	describe("AC#3: Team members notified and can accept/decline roles", () => {
		it("invites a member to the team", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			const member = builder.inviteMember(team.teamId, "agent-advisor", {
				role: "advisor",
				skills: ["domain-expertise"],
			});

			assert.equal(member.memberId, "agent-advisor");
			assert.equal(member.role, "advisor");
			assert.equal(member.status, "invited");
		});

		it("member can accept invitation", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.inviteMember(team.teamId, "agent-c", { role: "contributor" });

			const updated = builder.acceptInvitation(team.teamId, "agent-c");

			const member = updated.members.find((m) => m.memberId === "agent-c");
			assert.ok(member);
			assert.equal(member.status, "accepted");
			assert.ok(member.respondedAt);
		});

		it("member can decline invitation", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.inviteMember(team.teamId, "agent-c", { role: "contributor" });

			const updated = builder.declineInvitation(
				team.teamId,
				"agent-c",
				"Too busy",
			);

			const member = updated.members.find((m) => m.memberId === "agent-c");
			assert.ok(member);
			assert.equal(member.status, "declined");
		});

		it("prevents accepting non-existent invitation", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			assert.throws(
				() => builder.acceptInvitation(team.teamId, "agent-unknown"),
				/is not a team member/,
			);
		});

		it("prevents accepting twice", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.inviteMember(team.teamId, "agent-c");
			builder.acceptInvitation(team.teamId, "agent-c");

			assert.throws(
				() => builder.acceptInvitation(team.teamId, "agent-c"),
				/invitation status is: accepted/,
			);
		});

		it("owner can remove a member", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.inviteMember(team.teamId, "agent-c");
			builder.acceptInvitation(team.teamId, "agent-c");

			const updated = builder.removeMember(
				team.teamId,
				"agent-c",
				team.ownerId,
			);

			const member = updated.members.find((m) => m.memberId === "agent-c");
			assert.ok(member);
			assert.equal(member.status, "removed");
		});

		it("member can change role", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			const updated = builder.changeRole(
				team.teamId,
				"agent-b",
				"advisor",
				team.ownerId,
			);

			const member = updated.members.find((m) => m.memberId === "agent-b");
			assert.ok(member);
			assert.equal(member.role, "advisor");
		});

		it("changing to owner updates team owner", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.changeRole(team.teamId, "agent-b", "owner", team.ownerId);

			const updated = builder.getTeam(team.teamId);
			assert.equal(updated?.ownerId, "agent-b");
		});

		it("gets pending invitations for an agent", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.inviteMember(team.teamId, "agent-advisor", { role: "advisor" });

			const invitations = builder.getInvitations("agent-advisor");
			assert.equal(invitations.length, 1);
			assert.equal(invitations[0].member.role, "advisor");
		});
	});

	// ─── AC#4: Team Coordination Through Shared Lease or Chain ─────

	describe("AC#4: Team coordination through shared lease or lease chain", () => {
		it("activates a team with accepted members", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			// All members should be accepted (approved proposals)
			const activated = builder.activateTeam(team.teamId);

			assert.equal(activated.status, "active");
			assert.ok(activated.activatedAt);
		});

		it("requires at least 2 accepted members to activate", () => {
			// Create proposals with just one agent to form a small team
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			// All members from approved proposals start as "accepted"
			// So we need to add an invited member and have them decline
			builder.inviteMember(team.teamId, "agent-c", { role: "contributor" });
			builder.declineInvitation(team.teamId, "agent-c");

			// The invited member declined, but we still have 2 accepted members
			// So we need to also remove one of the original members
			builder.removeMember(team.teamId, "agent-b", team.ownerId);

			assert.throws(
				() => builder.activateTeam(team.teamId),
				/Need at least 2 accepted members/,
			);
		});

		it("completes a team", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);
			builder.activateTeam(team.teamId);

			const completed = builder.completeTeam(team.teamId, team.ownerId);

			assert.equal(completed.status, "completed");
			assert.ok(completed.completedAt);
		});

		it("dissolves a team", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			const dissolved = builder.dissolveTeam(team.teamId, team.ownerId);

			assert.equal(dissolved.status, "dissolved");
		});

		it("pauses a team", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);
			builder.activateTeam(team.teamId);

			const paused = builder.pauseTeam(team.teamId, team.ownerId);

			assert.equal(paused.status, "paused");
		});

		it("transfers lease in chain", () => {
			const proposals = createTestProposals("proposal-42", 3);
			const team = builder.formTeam("proposal-42", proposals, {
				coordinationStrategy: "lease-chain",
			});
			builder.activateTeam(team.teamId);

			const result = builder.transferLease(team.teamId, "agent-a");

			assert.ok(result.success);
			assert.equal(result.newHolder, "agent-b");

			const _updated = builder.getTeam(team.teamId);
			const currentHolder = builder.getCurrentLeaseHolder(team.teamId);
			assert.equal(currentHolder, "agent-b");
		});

		it("returns error for wrong agent transferring lease", () => {
			const proposals = createTestProposals("proposal-42", 3);
			const team = builder.formTeam("proposal-42", proposals, {
				coordinationStrategy: "lease-chain",
			});
			builder.activateTeam(team.teamId);

			const result = builder.transferLease(team.teamId, "agent-wrong");

			assert.ok(!result.success);
			assert.ok(result.message.includes("held by"));
		});

		it("completes chain when last segment finishes", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals, {
				coordinationStrategy: "lease-chain",
			});
			builder.activateTeam(team.teamId);

			// Transfer from first to second
			const first = builder.transferLease(team.teamId, "agent-a");
			assert.ok(first.success);

			// Transfer from second (last)
			const second = builder.transferLease(team.teamId, "agent-b");
			assert.ok(second.success);

			const completed = builder.getTeam(team.teamId);
			assert.equal(completed?.status, "completed");
		});

		it("provides coordination info", () => {
			const proposals = createTestProposals("proposal-42", 3);
			const team = builder.formTeam("proposal-42", proposals, {
				coordinationStrategy: "lease-chain",
			});
			builder.activateTeam(team.teamId);

			const info = builder.getCoordinationInfo(team.teamId);

			assert.ok(info);
			assert.equal(info.strategy, "lease-chain");
			assert.ok(info.currentHolder);
			assert.ok(info.chainProgress);
			assert.equal(info.chainProgress.completed, 0);
			assert.equal(info.chainProgress.total, 3);
		});

		it("gets team history", () => {
			const proposals = createTestProposals("proposal-42", 2);
			const team = builder.formTeam("proposal-42", proposals);

			builder.activateTeam(team.teamId);
			builder.completeTeam(team.teamId, team.ownerId);

			const history = builder.getTeamHistory(team.teamId);
			assert.ok(history.length >= 3); // formed, activated, completed

			const events = history.map((h) => h.event);
			assert.ok(events.includes("formed"));
			assert.ok(events.includes("activated"));
			assert.ok(events.includes("completed"));
		});

		it("provides team statistics", () => {
			const p1 = createTestProposals("proposal-1", 2);
			const p2 = createTestProposals("proposal-2", 2);

			builder.formTeam("proposal-1", p1);

			const team2 = builder.formTeam("proposal-2", p2);
			builder.activateTeam(team2.teamId);

			const stats = builder.getTeamStats();
			assert.equal(stats.totalTeams, 2);
			assert.ok(stats.formingTeams >= 1);
			assert.ok(stats.activeTeams >= 1);
			assert.ok(stats.avgTeamSize >= 2);
		});
	});
});
