/**
 * proposal-61: Agent Proposal & Lease-Based Backlog System - Tests
 *
 * Tests for:
 * - Proposal submission and review workflow
 * - Backlog item creation from approved proposals
 * - Lease management (acquire, renew, release, expire)
 * - Heartbeat proof generation and validation
 * - Dependency checking
 * - Statistics and summary generation
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
	type HeartbeatProof,
	LeaseBacklogManager,
} from "../../src/core/collaboration/lease-backlog.ts";

const TEST_STORAGE = join(
	import.meta.dirname,
	"..",
	"test-temp",
	"lease-backlog-test",
);

describe("proposal-61: Lease-Based Backlog System", () => {
	let manager: LeaseBacklogManager;

	beforeEach(() => {
		// Clean up test storage
		if (existsSync(TEST_STORAGE)) {
			rmSync(TEST_STORAGE, { recursive: true });
		}
		mkdirSync(TEST_STORAGE, { recursive: true });

		manager = new LeaseBacklogManager({
			storageDir: TEST_STORAGE,
			defaultLeaseHours: 1, // Short leases for testing
			maxRenewals: 2,
			requireHeartbeatProof: false, // Disabled for simpler tests
		});
	});

	describe("Proposal Submission", () => {
		it("should submit a new proposal", () => {
			const proposal = manager.submitProposal(
				"proposal-61",
				"Test Proposal",
				"agent-1",
				"Test description",
				["AC#1: Test acceptance criteria"],
				"high",
			);

			assert.equal(proposal.proposalId, "proposal-61");
			assert.equal(proposal.title, "Test Proposal");
			assert.equal(proposal.proposer, "agent-1");
			assert.equal(proposal.status, "Proposed");
			assert.ok(proposal.proposedAt);
		});

		it("should reject invalid proposal ID format", () => {
			assert.throws(
				() => manager.submitProposal("61", "Test", "agent-1", "desc", []),
				/Invalid proposal ID format/,
			);
		});

		it("should reject duplicate proposals", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			assert.throws(
				() =>
					manager.submitProposal("proposal-61", "Test2", "agent-2", "desc", []),
				/Proposal already exists/,
			);
		});
	});

	describe("Proposal Review", () => {
		it("should add reviews and track status", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);

			const review1 = manager.addReview(
				"proposal-61",
				"pm-user",
				"pm",
				"approved",
				"Looks good",
			);
			assert.equal(review1.status, "Under Review");

			const review2 = manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"LGTM",
			);
			assert.equal(review2.status, "Approved");
			assert.ok(review2.approvedBy);
			assert.ok(review2.approvedAt);
		});

		it("should reject if any reviewer rejects", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);

			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			const result = manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"rejected",
				"No",
			);

			assert.equal(result.status, "Rejected");
		});

		it("should reject review on non-existent proposal", () => {
			assert.throws(
				() =>
					manager.addReview("proposal-999", "pm-user", "pm", "approved", "OK"),
				/No proposal found/,
			);
		});
	});

	describe("Backlog Management", () => {
		it("should add approved proposal to backlog", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);

			const item = manager.addToBacklog(
				"proposal-61",
				"Description",
				["AC#1: Test"],
				"high",
				"2d",
				[],
			);

			assert.equal(item.proposalId, "proposal-61");
			assert.equal(item.status, "available");
			assert.equal(item.priority, "high");
		});

		it("should reject adding unapproved proposal to backlog", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");

			assert.throws(
				() => manager.addToBacklog("proposal-61", "desc", []),
				/not approved/,
			);
		});

		it("should reject adding duplicate to backlog", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			assert.throws(
				() => manager.addToBacklog("proposal-61", "desc2", []),
				/Backlog item already exists/,
			);
		});
	});

	describe("Lease Management", () => {
		const setupApprovedBacklog = () => {
			manager.submitProposal(
				"proposal-61",
				"Test Proposal",
				"agent-1",
				"desc",
				[],
			);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			return manager.addToBacklog(
				"proposal-61",
				"Description",
				["AC#1: Test"],
				"medium",
			);
		};

		it("should lease an available item", () => {
			setupApprovedBacklog();

			const lease = manager.leaseItem(
				"proposal-61",
				"agent-2",
				"Worker Agent",
				24,
			);

			assert.equal(lease.agentId, "agent-2");
			assert.equal(lease.status, "leased");
			assert.ok(lease.expiresAt);

			const item = manager.getItem("proposal-61");
			assert.equal(item?.status, "leased");
		});

		it("should reject leasing already leased item", () => {
			setupApprovedBacklog();

			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);

			assert.throws(
				() => manager.leaseItem("proposal-61", "agent-3", "Another Worker", 24),
				/already leased/,
			);
		});

		it("should allow leasing after expiry", () => {
			setupApprovedBacklog();

			// Lease with very short duration
			const shortManager = new LeaseBacklogManager({
				storageDir: TEST_STORAGE,
				defaultLeaseHours: 0.001, // ~3.6 seconds
			});

			shortManager.submitProposal(
				"proposal-62",
				"Test 2",
				"agent-1",
				"desc",
				[],
			);
			shortManager.addReview("proposal-62", "pm-user", "pm", "approved", "OK");
			shortManager.addReview(
				"proposal-62",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			shortManager.addToBacklog("proposal-62", "desc", []);

			shortManager.leaseItem("proposal-62", "agent-2", "Worker", 0.001);

			// Wait for expiry
			return new Promise((resolve) => {
				setTimeout(() => {
					// Should be able to lease again
					const lease = shortManager.leaseItem(
						"proposal-62",
						"agent-3",
						"New Worker",
						1,
					);
					assert.equal(lease.agentId, "agent-3");
					resolve(undefined);
				}, 4000);
			});
		});

		it("should release a lease early", () => {
			setupApprovedBacklog();

			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);

			const item = manager.releaseLease(
				"proposal-61",
				"agent-2",
				"Need to focus on other work",
			);

			assert.equal(item.status, "available");
			assert.equal(item.lease?.status, "expired");
		});

		it("should reject releasing someone else's lease", () => {
			setupApprovedBacklog();

			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);

			assert.throws(
				() => manager.releaseLease("proposal-61", "agent-3", "Not mine"),
				/belongs to/,
			);
		});

		it("should complete a leased item", () => {
			setupApprovedBacklog();

			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);

			const item = manager.completeItem("proposal-61", "agent-2");

			assert.equal(item.status, "completed");
			assert.equal(item.lease?.status, "completed");
		});
	});

	describe("Lease Renewal", () => {
		it("should renew a lease", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			manager.leaseItem("proposal-61", "agent-2", "Worker", 1);

			const renewedLease = manager.renewLease("proposal-61", "agent-2");

			assert.equal(renewedLease.renewedCount, 1);
			assert.ok(new Date(renewedLease.expiresAt).getTime() > Date.now());
		});

		it("should reject max renewals", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			manager.leaseItem("proposal-61", "agent-2", "Worker", 1);
			manager.renewLease("proposal-61", "agent-2"); // Renewal 1
			manager.renewLease("proposal-61", "agent-2"); // Renewal 2 (max)

			assert.throws(
				() => manager.renewLease("proposal-61", "agent-2"),
				/Maximum renewals/,
			);
		});

		it("should reject renewal by wrong agent", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			manager.leaseItem("proposal-61", "agent-2", "Worker", 1);

			assert.throws(
				() => manager.renewLease("proposal-61", "agent-3"),
				/belongs to/,
			);
		});
	});

	describe("Heartbeat Proof", () => {
		it("should generate and validate heartbeat proof", () => {
			const proof = manager.generateHeartbeatProof(
				"agent-1",
				"Working on feature",
				["proposal-50"],
			);

			assert.equal(proof.agentId, "agent-1");
			assert.ok(proof.timestamp);
			assert.ok(proof.nonce);
			assert.ok(proof.proofHash);

			assert.ok(manager.validateHeartbeatProof(proof));
		});

		it("should reject invalid proof", () => {
			const invalidProof: HeartbeatProof = {
				agentId: "agent-1",
				timestamp: new Date().toISOString(),
				nonce: "bad",
				workProgress: "test",
				proposalsCompleted: [],
				proofHash: "invalid",
			};

			assert.equal(manager.validateHeartbeatProof(invalidProof), false);
		});

		it("should reject expired proof", () => {
			const oldProof: HeartbeatProof = {
				agentId: "agent-1",
				timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
				nonce: "test",
				workProgress: "test",
				proposalsCompleted: [],
				proofHash: "any",
			};

			assert.equal(manager.validateHeartbeatProof(oldProof), false);
		});
	});

	describe("Dependency Checking", () => {
		it("should track unmet dependencies", () => {
			const unmet = manager.checkDependencies("proposal-61", [
				"proposal-50",
				"proposal-51",
			]);
			assert.deepEqual(unmet, ["proposal-50", "proposal-51"]);
		});

		it("should identify completed dependencies", () => {
			manager.submitProposal("proposal-50", "Dep 1", "agent-1", "desc", []);
			manager.addReview("proposal-50", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-50",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-50", "desc", []);
			manager.leaseItem("proposal-50", "agent-2", "Worker", 24);
			manager.completeItem("proposal-50", "agent-2");

			const unmet = manager.checkDependencies("proposal-61", [
				"proposal-50",
				"proposal-51",
			]);
			assert.deepEqual(unmet, ["proposal-51"]);
		});

		it("should prevent leasing with unmet dependencies", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", [], "medium", undefined, [
				"proposal-999",
			]);

			assert.throws(
				() => manager.leaseItem("proposal-61", "agent-2", "Worker", 24),
				/unmet dependencies/,
			);
		});
	});

	describe("Stale Lease Expiration", () => {
		it("should expire stale leases", async () => {
			const shortManager = new LeaseBacklogManager({
				storageDir: TEST_STORAGE,
				defaultLeaseHours: 0.001,
			});

			shortManager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			shortManager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			shortManager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			shortManager.addToBacklog("proposal-61", "desc", []);
			shortManager.leaseItem("proposal-61", "agent-2", "Worker", 0.001);

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 4000));

			const expired = shortManager.expireStaleLeases();
			assert.equal(expired.length, 1);
			assert.equal(expired[0].proposalId, "proposal-61");

			const item = shortManager.getItem("proposal-61");
			assert.equal(item?.status, "available");
		});
	});

	describe("Statistics & Summary", () => {
		it("should calculate correct statistics", () => {
			// Add multiple items
			for (const id of ["proposal-61", "proposal-62", "proposal-63"]) {
				manager.submitProposal(id, `Test ${id}`, "agent-1", "desc", []);
				manager.addReview(id, "pm-user", "pm", "approved", "OK");
				manager.addReview(id, "arch-user", "architect", "approved", "OK");
				manager.addToBacklog(id, "desc", []);
			}

			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);
			manager.leaseItem("proposal-62", "agent-3", "Worker", 24);
			manager.completeItem("proposal-62", "agent-3");

			const stats = manager.getStats();
			assert.equal(stats.totalProposals, 3);
			assert.equal(stats.approved, 3);
			assert.equal(stats.totalBacklog, 3);
			assert.equal(stats.available, 1); // proposal-63
			assert.equal(stats.leased, 1); // proposal-61
			assert.equal(stats.completed, 1); // proposal-62
		});

		it("should generate a readable summary", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", [], "high");
			manager.leaseItem("proposal-61", "agent-2", "Worker Agent", 24);

			const summary = manager.getSummary();

			assert.ok(summary.includes("Backlog Summary"));
			assert.ok(summary.includes("Currently Leased"));
			assert.ok(summary.includes("proposal-61"));
			assert.ok(summary.includes("Worker Agent"));
		});
	});

	describe("Persistence", () => {
		it("should save and load from disk", () => {
			// Create data
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			// Create new manager and load
			const newManager = new LeaseBacklogManager({ storageDir: TEST_STORAGE });
			newManager.loadFromDisk();

			const item = newManager.getItem("proposal-61");
			assert.ok(item);
			assert.equal(item.proposalId, "proposal-61");
			assert.equal(item.status, "available");

			const proposal = newManager.getProposal("proposal-61");
			assert.ok(proposal);
			assert.equal(proposal.status, "Approved");
		});
	});

	describe("Item Management", () => {
		it("should list available items by priority", () => {
			for (const id of ["proposal-61", "proposal-62", "proposal-63"]) {
				manager.submitProposal(id, `Test ${id}`, "agent-1", "desc", []);
				manager.addReview(id, "pm-user", "pm", "approved", "OK");
				manager.addReview(id, "arch-user", "architect", "approved", "OK");
			}

			manager.addToBacklog("proposal-61", "desc", [], "critical");
			manager.addToBacklog("proposal-62", "desc", [], "low");
			manager.addToBacklog("proposal-63", "desc", [], "high");

			const critical = manager.getItemsByPriority("critical");
			assert.equal(critical.length, 1);
			assert.equal(critical[0].proposalId, "proposal-61");
		});

		it("should remove proposal only if not in backlog", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);

			assert.ok(manager.removeProposal("proposal-61"));
			assert.equal(manager.getProposal("proposal-61"), undefined);
		});

		it("should reject removing proposal that's in backlog", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			assert.throws(
				() => manager.removeProposal("proposal-61"),
				/exists in backlog/,
			);
		});

		it("should reject removing leased backlog item", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);
			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);

			assert.throws(
				() => manager.removeBacklogItem("proposal-61"),
				/currently leased/,
			);
		});

		it("should remove completed backlog item", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);
			manager.leaseItem("proposal-61", "agent-2", "Worker", 24);
			manager.completeItem("proposal-61", "agent-2");

			assert.ok(manager.removeBacklogItem("proposal-61"));
			assert.equal(manager.getItem("proposal-61"), undefined);
		});
	});

	describe("Clear", () => {
		it("should clear all data", () => {
			manager.submitProposal("proposal-61", "Test", "agent-1", "desc", []);
			manager.addReview("proposal-61", "pm-user", "pm", "approved", "OK");
			manager.addReview(
				"proposal-61",
				"arch-user",
				"architect",
				"approved",
				"OK",
			);
			manager.addToBacklog("proposal-61", "desc", []);

			manager.clear();

			assert.equal(manager.listProposals().length, 0);
			assert.equal(manager.listAll().length, 0);
		});
	});
});
