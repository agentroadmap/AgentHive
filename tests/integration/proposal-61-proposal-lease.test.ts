/**
 * Tests for proposal-61: Agent Proposal & Lease-Based Backlog System
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	createHeartbeatProof,
	generateProposalTemplate,
	isValidProposalTitle,
	ProposalLeaseManager,
} from "../../src/core/collaboration/proposal-lease.ts";

describe("proposal-61: Agent Proposal & Lease-Based Backlog System", () => {
	let tempDir: string;
	let manager: ProposalLeaseManager;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "proposal-lease-test-"));
		manager = new ProposalLeaseManager(join(tempDir, "proposals"));
		await manager.initialize();
	});

	after(async () => {
		manager.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("Proposal Submission", () => {
		it("AC#1: should allow any agent to submit a proposal", () => {
			const proposal = manager.submitProposal({
				proposalId: "proposal-100",
				title: "New Feature Proposal",
				description: "A detailed description of the proposed feature",
				proposedBy: "agent-alice",
				tags: ["feature", "core"],
				priority: "high",
				estimatedEffort: "M",
			});

			assert.ok(proposal.proposalId);
			assert.equal(proposal.proposalId, "proposal-100");
			assert.equal(proposal.title, "New Feature Proposal");
			assert.equal(proposal.proposedBy, "agent-alice");
			assert.equal(proposal.status, "proposed");
			assert.deepEqual(proposal.tags, ["feature", "core"]);
			assert.equal(proposal.priority, "high");
		});

		it("should reject duplicate proposals for the same proposal", () => {
			assert.throws(() => {
				manager.submitProposal({
					proposalId: "proposal-100",
					title: "Duplicate Proposal",
					description: "This should fail",
					proposedBy: "agent-bob",
				});
			}, /Active proposal already exists/);
		});

		it("AC#1: should track proposals in group pulse", () => {
			const pulse = manager.getGroupPulse({ type: "proposal" });
			assert.ok(pulse.length >= 1);
			assert.equal(pulse[0]?.agentId, "agent-alice");
			assert.ok(pulse[0]?.content.includes("New Feature Proposal"));
		});
	});

	describe("Proposal Discussion", () => {
		it("AC#1: should allow comments on proposals", () => {
			const proposals = manager.getProposalsByStatus("proposed");
			const proposalId = proposals[0].proposalId;

			const comment = manager.addProposalComment(
				proposalId,
				"agent-bob",
				"Looks interesting, what about scalability?",
			);

			assert.ok(comment.entryId);
			assert.ok(comment.content.includes("scalability"));

			// Status should change to in-review
			const updated = manager.getProposal(proposalId);
			assert.equal(updated?.status, "in-review");
		});
	});

	describe("Proposal Review (AC#2)", () => {
		let proposalId: string;

		before(() => {
			// Submit a new proposal for review tests
			const proposal = manager.submitProposal({
				proposalId: "proposal-101",
				title: "Review Test Proposal",
				description: "For testing reviews",
				proposedBy: "agent-charlie",
			});
			proposalId = proposal.proposalId;
		});

		it("AC#2: should accept PM review", () => {
			const review = manager.submitReview({
				proposalId,
				reviewerId: "pm-diana",
				reviewerRole: "pm",
				recommendation: "approve",
				score: 8,
				comments: "Good product-market fit",
			});

			assert.ok(review.reviewId);
			assert.equal(review.reviewerRole, "pm");
			assert.equal(review.recommendation, "approve");
			assert.equal(review.score, 8);
		});

		it("AC#2: should accept Architect review", () => {
			const review = manager.submitReview({
				proposalId,
				reviewerId: "architect-eve",
				reviewerRole: "architect",
				recommendation: "approve",
				score: 9,
				comments: "Technically sound approach",
			});

			assert.ok(review.reviewId);
			assert.equal(review.reviewerRole, "architect");
		});

		it("should prevent duplicate reviews from same role", () => {
			assert.throws(() => {
				manager.submitReview({
					proposalId,
					reviewerId: "pm-frank",
					reviewerRole: "pm",
					recommendation: "approve",
					score: 7,
					comments: "Another PM review",
				});
			}, /pm review already exists/);
		});

		it("should track reviews in group pulse", () => {
			const reviews = manager.getGroupPulse({ type: "review" });
			assert.ok(reviews.length >= 2);
		});
	});

	describe("Approval Recording (AC#3)", () => {
		let proposalId: string;

		before(() => {
			// Create a proposal with both reviews
			const proposal = manager.submitProposal({
				proposalId: "proposal-102",
				title: "Approval Test",
				description: "For testing approval",
				proposedBy: "agent-george",
			});
			proposalId = proposal.proposalId;

			// PM review
			manager.submitReview({
				proposalId,
				reviewerId: "pm-hannah",
				reviewerRole: "pm",
				recommendation: "approve",
				score: 8,
				comments: "Approved",
			});

			// Architect review
			manager.submitReview({
				proposalId,
				reviewerId: "architect-ivan",
				reviewerRole: "architect",
				recommendation: "approve",
				score: 9,
				comments: "Approved",
			});
		});

		it("AC#3: should record approval with proposer, approver, timestamp", () => {
			const approved = manager.approveProposal(proposalId, "lead-julia");

			assert.equal(approved.status, "approved");
			assert.equal(approved.approvedBy, "lead-julia");
			assert.ok(approved.approvedAt);
		});

		it("AC#3: should provide complete approval info", () => {
			const info = manager.getApprovalInfo(proposalId);

			assert.ok(info);
			assert.equal(info.proposedBy, "agent-george");
			assert.ok(info.proposedAt);
			assert.equal(info.approvedBy, "lead-julia");
			assert.ok(info.approvedAt);
			assert.equal(info.reviews.length, 2);
		});

		it("should require both PM and Architect approval", () => {
			// Create a proposal with only PM approval
			const proposal = manager.submitProposal({
				proposalId: "proposal-103",
				title: "Incomplete Approval",
				description: "Only has PM review",
				proposedBy: "agent-karen",
			});

			manager.submitReview({
				proposalId: proposal.proposalId,
				reviewerId: "pm-leo",
				reviewerRole: "pm",
				recommendation: "approve",
				score: 8,
				comments: "PM approved",
			});

			assert.throws(() => {
				manager.approveProposal(proposal.proposalId, "lead-mike");
			}, /requires both PM and Architect approval/);
		});

		it("should add approved items to backlog", () => {
			const available = manager.getAvailableBacklog();
			assert.ok(available.length >= 1);
			assert.ok(available.some((i) => i.proposalId === "proposal-102"));
		});
	});

	describe("Lease Management (AC#4)", () => {
		let backlogItemId: string;

		before(() => {
			// Find an available backlog item
			const available = manager.getAvailableBacklog();
			backlogItemId = available[0]?.itemId;
		});

		it("AC#4: should allow leasing a backlog item for 48h default", () => {
			const lease = manager.leaseItem(backlogItemId, "agent-nancy");

			assert.ok(lease.leaseId);
			assert.equal(lease.agentId, "agent-nancy");
			assert.equal(lease.status, "active");
			assert.ok(lease.heartbeatToken);

			// Check expiry is ~48h from now
			const expiresAt = new Date(lease.expiresAt).getTime();
			const now = Date.now();
			const hours48 = 48 * 60 * 60 * 1000;
			assert.ok(expiresAt - now > hours48 - 60000); // Within 1 minute of 48h
			assert.ok(expiresAt - now < hours48 + 60000);
		});

		it("should prevent leasing an already leased item", () => {
			assert.throws(() => {
				manager.leaseItem(backlogItemId, "agent-oliver");
			}, /already leased/);
		});

		it("AC#4: should allow leasing with custom duration", () => {
			// First release the lease
			const leases = manager.getAgentLeases("agent-nancy");
			manager.releaseLease(leases[0]?.leaseId, "agent-nancy");

			// Now lease with custom duration (1 hour)
			const oneHour = 60 * 60 * 1000;
			const lease = manager.leaseItem(backlogItemId, "agent-oliver", {
				durationMs: oneHour,
			});

			const expiresAt = new Date(lease.expiresAt).getTime();
			const now = Date.now();
			assert.ok(expiresAt - now > oneHour - 60000);
			assert.ok(expiresAt - now < oneHour + 60000);

			// Cleanup
			manager.releaseLease(lease.leaseId, "agent-oliver");
		});
	});

	describe("Lease Expiry (AC#5)", () => {
		it("AC#5: should expire leases and return items to backlog", async () => {
			// Create a lease with very short duration for testing
			const available = manager.getAvailableBacklog();
			if (available.length === 0) {
				// No available items, skip
				return;
			}

			const item = available[0]!;
			const shortDuration = 100; // 100ms
			const lease = manager.leaseItem(item.itemId, "agent-pat", {
				durationMs: shortDuration,
			});

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Check expired leases
			const expired = manager.checkExpiredLeases();
			assert.ok(expired.length >= 1);
			assert.ok(expired.some((l) => l.leaseId === lease.leaseId));

			// Item should be back in available
			const updatedItem = manager.getBacklogItem(item.itemId);
			assert.equal(updatedItem?.status, "available");
			assert.equal(updatedItem?.currentLeaseId, undefined);
		});
	});

	describe("Heartbeat Renewal (AC#6)", () => {
		let leaseId: string;
		let _heartbeatToken: string;

		before(() => {
			const available = manager.getAvailableBacklog();
			if (available.length > 0) {
				const lease = manager.leaseItem(available[0]?.itemId, "agent-quincy");
				leaseId = lease.leaseId;
				_heartbeatToken = lease.heartbeatToken || "";
			}
		});

		it("AC#6: should allow lease renewal with heartbeat proof", () => {
			if (!leaseId) return; // Skip if no lease was created

			const proof = createHeartbeatProof(leaseId, "agent-quincy");
			const renewed = manager.renewLease(proof);

			assert.equal(renewed.renewalCount, 1);
			assert.ok(renewed.lastHeartbeat);
		});

		it("AC#6: should track renewal count", () => {
			if (!leaseId) return;

			const proof1 = createHeartbeatProof(leaseId, "agent-quincy");
			const proof2 = createHeartbeatProof(leaseId, "agent-quincy");

			manager.renewLease(proof1);
			const renewed = manager.renewLease(proof2);

			assert.equal(renewed.renewalCount, 3); // Was 1, added 2 more
		});

		it("AC#6: should prevent exceeding max renewals", () => {
			if (!leaseId) return;

			// Already at max (3), should fail
			const proof = createHeartbeatProof(leaseId, "agent-quincy");
			assert.throws(() => {
				manager.renewLease(proof);
			}, /Maximum renewals/);
		});

		it("should allow direct heartbeat submission", () => {
			if (!leaseId) return;

			const lease = manager.submitHeartbeat(leaseId, "agent-quincy");
			assert.ok(lease.lastHeartbeat);
		});
	});

	describe("Group Pulse Tracking (AC#7)", () => {
		it("AC#7: should track all proposals with agent attribution", () => {
			const pulse = manager.getGroupPulse({ type: "proposal" });

			for (const entry of pulse) {
				assert.ok(
					entry.agentId,
					"Each pulse entry should have agent attribution",
				);
				assert.ok(entry.timestamp);
				assert.ok(entry.content);
			}
		});

		it("AC#7: should track leases in pulse", () => {
			const pulse = manager.getGroupPulse({ type: "lease" });
			assert.ok(pulse.length >= 1);
		});

		it("AC#7: should allow filtering pulse by agent", () => {
			const alicePulse = manager.getGroupPulse({ agentId: "agent-alice" });
			assert.ok(alicePulse.every((e) => e.agentId === "agent-alice"));
		});

		it("AC#7: should allow filtering pulse by time", () => {
			const since = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
			const recentPulse = manager.getGroupPulse({ since });

			for (const entry of recentPulse) {
				assert.ok(entry.timestamp >= since);
			}
		});

		it("AC#7: should support limiting results", () => {
			const limited = manager.getGroupPulse({ limit: 3 });
			assert.ok(limited.length <= 3);
		});
	});

	describe("Statistics", () => {
		it("should provide accurate statistics", () => {
			const stats = manager.getStats();

			assert.ok(stats.totalProposals >= 4);
			assert.ok(stats.approved >= 1);
			assert.ok(stats.totalPulseEntries >= 1);
			assert.equal(typeof stats.backlogAvailable, "number");
			assert.equal(typeof stats.activeLeases, "number");
		});
	});

	describe("Helpers", () => {
		it("should validate proposal titles", () => {
			assert.equal(isValidProposalTitle("Valid Title"), true);
			assert.equal(isValidProposalTitle("AB"), false); // Too short
			assert.equal(isValidProposalTitle("x".repeat(201)), false); // Too long
		});

		it("should generate proposal template", () => {
			const template = generateProposalTemplate(
				"proposal-200",
				"Template Test",
				"agent-test",
			);

			assert.ok(template.includes("proposal-200"));
			assert.ok(template.includes("Template Test"));
			assert.ok(template.includes("agent-test"));
		});

		it("should create valid heartbeat proofs", () => {
			const proof = createHeartbeatProof("LEASE-123", "agent-test");

			assert.ok(proof.leaseId);
			assert.ok(proof.agentId);
			assert.ok(proof.heartbeatHash);
			assert.ok(proof.timestamp);
			assert.ok(proof.nonce);
		});
	});
});
