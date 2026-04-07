/**
 * Tests for proposal-61: Agent Proposal & Lease-Based Backlog System
 *
 * AC#1: Agent can submit a proposal for a proposal
 * AC#2: Proposal includes implementation approach + estimated complexity
 * AC#3: Proposal review workflow (Pending → Approved → Rejected)
 * AC#4: Only approved proposals can claim the proposal (lease)
 * AC#5: Proposal feedback visible to all agents (learning signal)
 * AC#6: Proposal history preserved for retrospective analysis
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
	AgentProposalSystem,
	type ComplexityEstimate,
	createApproach,
	createComplexityEstimate,
	type ImplementationApproach,
} from "../../src/core/collaboration/agent-proposals.ts";

describe("proposal-61: Agent Proposal & Lease-Based Backlog System", () => {
	let system: AgentProposalSystem;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-proposals-"));
		system = new AgentProposalSystem({ proposalDir: tempDir });
	});

	// Helper functions
	function createTestApproach(): ImplementationApproach {
		return createApproach(
			"new-feature",
			"Build the feature using a new module",
			{
				filesAffected: ["src/core/feature.ts", "src/test/feature.test.ts"],
				dependencies: [],
				estimatedTimeline: "2 days",
				risks: ["Integration issues"],
			},
		);
	}

	function createTestComplexity(): ComplexityEstimate {
		return createComplexityEstimate("medium", {
			estimatedHours: 16,
			confidence: 0.7,
		});
	}

	// ─── AC#1: Agent Can Submit a Proposal ─────────────────────────

	describe("AC#1: Agent can submit a proposal for a proposal", () => {
		it("submits a new proposal successfully", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Implement Multi-Host Federation",
				summary: "Build the federation layer for cross-host communication",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.ok(proposal.proposalId, "Should have a proposal ID");
			assert.equal(proposal.proposalId, "proposal-42");
			assert.equal(proposal.agentId, "agent-alpha");
			assert.equal(proposal.status, "pending");
			assert.ok(proposal.submittedAt, "Should have submission timestamp");
			assert.equal(proposal.claimed, false);
		});

		it("retrieves proposal by ID", () => {
			const submitted = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Test Proposal",
				summary: "A test",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const retrieved = system.getProposal(submitted.proposalId);
			assert.ok(retrieved);
			assert.equal(retrieved.proposalId, submitted.proposalId);
			assert.equal(retrieved.title, "Test Proposal");
		});

		it("prevents duplicate pending proposals for same proposal", () => {
			system.submitProposal("proposal-42", "agent-alpha", {
				title: "First Proposal",
				summary: "First",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.throws(
				() =>
					system.submitProposal("proposal-42", "agent-beta", {
						title: "Second Proposal",
						summary: "Second",
						approach: createTestApproach(),
						complexity: createTestComplexity(),
					}),
				/already has an active proposal/,
			);
		});

		it("allows new proposal after previous was rejected", () => {
			const first = system.submitProposal("proposal-42", "agent-alpha", {
				title: "First",
				summary: "First",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.rejectProposal(first.proposalId, "reviewer-1");

			const second = system.submitProposal("proposal-42", "agent-beta", {
				title: "Second",
				summary: "Second",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.ok(second);
			assert.equal(second.status, "pending");
		});

		it("prevents proposal when proposal is already leased", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			assert.throws(
				() =>
					system.submitProposal("proposal-42", "agent-beta", {
						title: "Another",
						summary: "Another",
						approach: createTestApproach(),
						complexity: createTestComplexity(),
					}),
				/already leased/,
			);
		});

		it("queries proposals with filters", () => {
			system.submitProposal("proposal-1", "agent-alpha", {
				title: "A1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.submitProposal("proposal-2", "agent-beta", {
				title: "B1",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			// Filter by agent
			const alphaProposals = system.getProposals({ agentId: "agent-alpha" });
			assert.equal(alphaProposals.length, 1);
			assert.equal(alphaProposals[0]?.agentId, "agent-alpha");

			// Filter by status
			const pendingProposals = system.getProposals({ status: "pending" });
			assert.equal(pendingProposals.length, 2);
		});
	});

	// ─── AC#2: Approach + Complexity ────────────────────────────────

	describe("AC#2: Proposal includes implementation approach + estimated complexity", () => {
		it("stores approach with all fields", () => {
			const approach = createApproach(
				"new-feature",
				"Build federation protocol",
				{
					filesAffected: ["src/core/federation.ts"],
					dependencies: ["ws", "node-forge"],
					estimatedTimeline: "3 days",
					testingStrategy: "Integration tests with mock hosts",
					risks: ["Network partition handling"],
					rollbackPlan: "Revert to file-based sharing",
				},
			);

			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Federation",
				summary: "Multi-host support",
				approach,
				complexity: createTestComplexity(),
			});

			assert.equal(proposal.approach.type, "new-feature");
			assert.equal(proposal.approach.filesAffected.length, 1);
			assert.equal(proposal.approach.dependencies.length, 2);
			assert.ok(proposal.approach.rollbackPlan);
		});

		it("stores complexity with level and score", () => {
			const complexity = createComplexityEstimate("high", {
				estimatedHours: 40,
				confidence: 0.6,
				tasks: [
					{
						description: "Design protocol",
						level: "medium",
						dependsOn: [],
					},
					{
						description: "Implement server",
						level: "high",
						dependsOn: [0],
					},
				],
			});

			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Complex Feature",
				summary: "Something complex",
				approach: createTestApproach(),
				complexity,
			});

			assert.equal(proposal.complexity.level, "high");
			assert.equal(proposal.complexity.score, 7); // high = 7
			assert.equal(proposal.complexity.tasks.length, 2);
			assert.ok(proposal.complexity.estimatedHours);
		});

		it("updates approach on pending proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const newApproach = createApproach("refactor", "Refactor existing code");
			const updated = system.updateApproach(
				proposal.proposalId,
				"agent-alpha",
				newApproach,
			);

			assert.equal(updated.approach.type, "refactor");
			assert.ok(updated.version > 1);
		});

		it("updates complexity on pending proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const newComplexity = createComplexityEstimate("very-high", {
				estimatedHours: 80,
			});
			const updated = system.updateComplexity(
				proposal.proposalId,
				"agent-alpha",
				newComplexity,
			);

			assert.equal(updated.complexity.level, "very-high");
			assert.equal(updated.complexity.score, 10);
		});

		it("returns complexity summary", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createComplexityEstimate("high", {
					estimatedHours: 30,
					confidence: 0.8,
					tasks: [
						{ description: "T1", level: "low", dependsOn: [] },
						{ description: "T2", level: "medium", dependsOn: [0] },
					],
				}),
			});

			const summary = system.getComplexitySummary(proposal.proposalId);
			assert.ok(summary);
			assert.equal(summary.level, "high");
			assert.equal(summary.taskCount, 2);
			assert.equal(summary.blockedTaskCount, 1); // T2 depends on T1
			assert.ok(summary.estimatedHours);
		});

		it("prevents updating non-pending proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");

			assert.throws(
				() =>
					system.updateApproach(
						proposal.proposalId,
						"agent-alpha",
						createTestApproach(),
					),
				/Cannot update proposal in status/,
			);
		});
	});

	// ─── AC#3: Proposal Review Workflow ─────────────────────────────

	describe("AC#3: Proposal review workflow", () => {
		it("moves from pending to approved", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.equal(proposal.status, "pending");

			const approved = system.approveProposal(
				proposal.proposalId,
				"reviewer-1",
				{
					notes: "Well thought out approach",
				},
			);

			assert.equal(approved.status, "approved");
			assert.equal(approved.reviewedBy, "reviewer-1");
			assert.ok(approved.reviewedAt);
			assert.equal(approved.reviewNotes, "Well thought out approach");
		});

		it("moves from pending to rejected", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const rejected = system.rejectProposal(
				proposal.proposalId,
				"reviewer-1",
				{
					notes: "Needs more research on edge cases",
					feedback: [
						{
							category: "approach",
							content: "Missing error handling for network failures",
							suggestion: "Add retry logic with exponential backoff",
							severity: "blocker",
						},
					],
				},
			);

			assert.equal(rejected.status, "rejected");
			assert.equal(rejected.feedback.length, 1);
			assert.equal(rejected.feedback[0]?.severity, "blocker");
		});

		it("prevents reviewing already reviewed proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");

			assert.throws(
				() => system.approveProposal(proposal.proposalId, "reviewer-2"),
				/Cannot review proposal in status/,
			);
		});

		it("agent can withdraw pending proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const withdrawn = system.withdrawProposal(
				proposal.proposalId,
				"agent-alpha",
			);
			assert.equal(withdrawn.status, "withdrawn");
		});

		it("prevents non-proposer from withdrawing", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.throws(
				() => system.withdrawProposal(proposal.proposalId, "agent-beta"),
				/Only the proposing agent can withdraw/,
			);
		});

		it("gets pending proposals for review", () => {
			system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const proposal2 = system.submitProposal("proposal-2", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal2.proposalId, "reviewer-1");

			const pending = system.getPendingProposals();
			assert.equal(pending.length, 1);
			assert.equal(pending[0]?.proposalId, "proposal-1");
		});

		it("computes review statistics", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const p2 = system.submitProposal("proposal-2", "agent-alpha", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			const _p3 = system.submitProposal("proposal-3", "agent-beta", {
				title: "F3",
				summary: "S3",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(p1.proposalId, "reviewer-1");
			system.rejectProposal(p2.proposalId, "reviewer-1");

			const stats = system.getReviewStats();
			assert.equal(stats.pending, 1);
			assert.equal(stats.approved, 1);
			assert.equal(stats.rejected, 1);
			assert.equal(stats.withdrawn, 0);
			assert.ok(stats.avgReviewTimeMs !== undefined);
		});
	});

	// ─── AC#4: Only Approved Proposals Can Claim (Lease) ───────────

	describe("AC#4: Only approved proposals can claim the proposal (lease)", () => {
		it("claims proposal with approved proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			const lease = system.claimProposal(proposal.proposalId);

			assert.ok(lease);
			assert.equal(lease.proposalId, "proposal-42");
			assert.equal(lease.agentId, "agent-alpha");
			assert.equal(lease.status, "active");
			assert.ok(lease.expiresAt);
			assert.ok(lease.proposalId);
		});

		it("prevents claiming with pending proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			assert.throws(
				() => system.claimProposal(proposal.proposalId),
				/Proposal must be approved before claiming/,
			);
		});

		it("prevents double-claiming with same proposal", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			assert.throws(
				() => system.claimProposal(proposal.proposalId),
				/has already been used to claim/,
			);
		});

		it("checks if proposal is leased", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			assert.ok(system.isProposalLeased("proposal-42"));
			assert.ok(!system.isProposalLeased("proposal-99"));
		});

		it("renews lease via heartbeat", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			const result = system.heartbeatLease("proposal-42", "agent-alpha");
			assert.ok(result.ok);
			if (result.ok) {
				// Lease should still be active with renewed expiry
				assert.equal(result.lease.status, "active");
				assert.ok(result.lease.lastHeartbeat);
				// The new expiry should be in the future
				assert.ok(new Date(result.lease.expiresAt) > new Date());
			}
		});

		it("rejects heartbeat from wrong agent", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			const result = system.heartbeatLease("proposal-42", "agent-beta");
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, "wrong-agent");
			}
		});

		it("releases lease voluntarily", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			const released = system.releaseLease("proposal-42", "agent-alpha");
			assert.ok(released);
			assert.ok(!system.isProposalLeased("proposal-42"));
		});

		it("revokes lease via admin action", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			const revoked = system.revokeLease(
				"proposal-42",
				"admin",
				"Policy violation",
			);
			assert.ok(revoked);
			assert.ok(!system.isProposalLeased("proposal-42"));
		});

		it("cleans up expired leases", () => {
			const shortTtlSystem = new AgentProposalSystem({ leaseTtlMs: 10 });

			const proposal = shortTtlSystem.submitProposal(
				"proposal-42",
				"agent-alpha",
				{
					title: "Feature",
					summary: "Summary",
					approach: createTestApproach(),
					complexity: createTestComplexity(),
				},
			);

			shortTtlSystem.approveProposal(proposal.proposalId, "reviewer-1");
			shortTtlSystem.claimProposal(proposal.proposalId);

			// Wait for lease to expire
			return new Promise((resolve) => {
				setTimeout(() => {
					const cleaned = shortTtlSystem.cleanupExpiredLeases();
					assert.equal(cleaned, 1);
					resolve(undefined);
				}, 50);
			});
		});

		it("gets active leases", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p1.proposalId, "reviewer-1");
			system.claimProposal(p1.proposalId);

			const p2 = system.submitProposal("proposal-2", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p2.proposalId, "reviewer-1");
			system.claimProposal(p2.proposalId);

			const activeLeases = system.getActiveLeases();
			assert.equal(activeLeases.length, 2);
		});

		it("gets leases for specific agent", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p1.proposalId, "reviewer-1");
			system.claimProposal(p1.proposalId);

			const p2 = system.submitProposal("proposal-2", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p2.proposalId, "reviewer-1");
			system.claimProposal(p2.proposalId);

			const alphaLeases = system.getAgentLeases("agent-alpha");
			assert.equal(alphaLeases.length, 1);
			assert.equal(alphaLeases[0]?.proposalId, "proposal-1");
		});
	});

	// ─── AC#5: Proposal Feedback Visible to All Agents ─────────────

	describe("AC#5: Proposal feedback visible to all agents (learning signal)", () => {
		it("stores and retrieves feedback", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.rejectProposal(proposal.proposalId, "reviewer-1", {
				feedback: [
					{
						category: "approach",
						content: "Missing error handling",
						suggestion: "Add try-catch blocks around network calls",
						severity: "blocker",
					},
					{
						category: "complexity",
						content: "Underestimated complexity",
						severity: "warning",
					},
				],
			});

			const feedback = system.getProposalFeedback(proposal.proposalId);
			assert.equal(feedback.length, 2);
			assert.equal(feedback[0]?.category, "approach");
			assert.equal(feedback[0]?.severity, "blocker");
			assert.ok(feedback[0]?.suggestion);
		});

		it("gets feedback across proposals for a proposal", () => {
			const p1 = system.submitProposal("proposal-42", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.rejectProposal(p1.proposalId, "reviewer-1", {
				feedback: [
					{
						category: "approach",
						content: "Missing security",
						severity: "blocker",
					},
				],
			});

			// After rejection, new proposal can be submitted
			const p2 = system.submitProposal("proposal-42", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p2.proposalId, "reviewer-1", {
				feedback: [
					{ category: "general", content: "Good approach", severity: "info" },
				],
			});

			const proposalFeedback = system.getProposalFeedback("proposal-42");
			assert.equal(proposalFeedback.length, 2);
		});

		it("provides learning signal summary", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.rejectProposal(p1.proposalId, "reviewer-1", {
				feedback: [
					{
						category: "approach",
						content: "Bad approach",
						severity: "blocker",
					},
					{
						category: "approach",
						content: "Missing tests",
						severity: "warning",
					},
				],
			});

			const p2 = system.submitProposal("proposal-2", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.rejectProposal(p2.proposalId, "reviewer-1", {
				feedback: [
					{ category: "scope", content: "Too broad", severity: "warning" },
				],
			});

			const signals = system.getLearningSignals();
			assert.ok(signals.commonCategories.has("approach"));
			assert.equal(signals.blockerCount, 1);
			assert.equal(signals.warningCount, 2);
			assert.equal(signals.topIssues.length, 1);
		});
	});

	// ─── AC#6: Proposal History for Retrospective ──────────────────

	describe("AC#6: Proposal history preserved for retrospective analysis", () => {
		it("records history for proposal lifecycle", () => {
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});

			system.approveProposal(proposal.proposalId, "reviewer-1");
			system.claimProposal(proposal.proposalId);

			const history = system.getProposalHistory("proposal-42");
			assert.ok(history.length >= 3); // submitted, approved, claimed

			const events = history.map((h) => h.event);
			assert.ok(events.includes("submitted"));
			assert.ok(events.includes("approved"));
			assert.ok(events.includes("claimed"));
		});

		it("gets agent-specific history", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(p1.proposalId, "reviewer-1");

			const p2 = system.submitProposal("proposal-2", "agent-alpha", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.rejectProposal(p2.proposalId, "reviewer-1");

			const agentHistory = system.getAgentHistory("agent-alpha");
			// At minimum, two submissions
			const submissions = agentHistory.filter((h) => h.event === "submitted");
			assert.equal(submissions.length, 2);
		});

		it("generates retrospective summary", () => {
			const p1 = system.submitProposal("proposal-1", "agent-alpha", {
				title: "F1",
				summary: "S1",
				approach: createTestApproach(),
				complexity: createComplexityEstimate("low", { estimatedHours: 8 }),
			});
			system.approveProposal(p1.proposalId, "reviewer-1");

			const p2 = system.submitProposal("proposal-2", "agent-beta", {
				title: "F2",
				summary: "S2",
				approach: createTestApproach(),
				complexity: createComplexityEstimate("high", { estimatedHours: 40 }),
			});
			system.rejectProposal(p2.proposalId, "reviewer-1");

			const retro = system.getRetrospective("2000-01-01T00:00:00Z");
			assert.equal(retro.totalProposals, 2);
			assert.equal(retro.approvedCount, 1);
			assert.equal(retro.rejectedCount, 1);
			assert.ok(retro.avgComplexityScore > 0);
			assert.ok(retro.agentActivity.has("agent-alpha"));
			assert.ok(retro.agentActivity.has("agent-beta"));
		});

		it("persists and loads from disk", () => {
			// Submit and approve a proposal
			const proposal = system.submitProposal("proposal-42", "agent-alpha", {
				title: "Feature",
				summary: "Summary",
				approach: createTestApproach(),
				complexity: createTestComplexity(),
			});
			system.approveProposal(proposal.proposalId, "reviewer-1");

			// Persist
			system.persistToDisk(tempDir);

			// Create a new system and load
			const newSystem = new AgentProposalSystem({ proposalDir: tempDir });
			const loaded = newSystem.getProposal(proposal.proposalId);

			assert.ok(loaded);
			assert.equal(loaded.proposalId, "proposal-42");
			assert.equal(loaded.status, "approved");

			// History should also be loaded
			const history = newSystem.getProposalHistory("proposal-42");
			assert.ok(history.length >= 2);
		});
	});
});
