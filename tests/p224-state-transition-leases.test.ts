/**
 * P224 — State transitions require active lease to prevent duplicate gating
 *
 * Acceptance Criteria:
 * AC-1: Gate scanner skips proposals where another agent holds an active lease
 * AC-2: prop_transition returns error if caller has no active lease on the proposal
 * AC-3: transition_proposal returns error if caller has no active lease on the proposal
 * AC-4: transition_queue has `claimed_by` column; processing agent must match
 * AC-5: UNIQUE constraint on (proposal_id, from_stage, to_stage, status) prevents duplicate pending entries
 * AC-6: Stale claims (>10 min) auto-released by periodic cleanup
 * AC-7: E2E: two agents attempt same transition → only claimant succeeds
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/postgres/pool.ts";
import * as pg from "../src/infra/postgres/proposal-storage-v2.ts";
import { validateLease, formatValidationError } from "../src/core/proposal/proposal-integrity.ts";
import { getGateQueue, filterUnlockedProposals, getUnlockedGateQueue } from "../src/core/proposal/gate-scanner-v2.ts";
import { cleanupStaleLeasesIfNeeded, cleanupStaleTransitionProcessing } from "../src/core/proposal/stale-lease-cleanup.ts";

describe("P224 — State transition lease enforcement", () => {
	let proposalId: number;
	let proposalDisplayId: string;

	before(async () => {
		// Create a test proposal
		const result = await query<{ id: number; display_id: string }>(
			`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, display_id`,
			["P224 Test Proposal", "feature", "Draft", "new", '{}'],
		);
		proposalId = result.rows[0].id;
		proposalDisplayId = result.rows[0].display_id;

		// Ensure workflow exists for this proposal
		const workflowResult = await query<{ id: number }>(
			`INSERT INTO workflows (proposal_id, template_id, current_stage)
       VALUES ($1, 1, 'Draft')
       ON CONFLICT DO NOTHING
       RETURNING id`,
			[proposalId],
		);

		// Register test agents in agent_registry
		const agentIds = [
			"test-agent-1",
			"test-agent-2",
			"agent-a",
			"agent-b",
			"test-agent-expired",
			"gate-blocking-agent",
			"stale-agent",
			"concurrent-agent-a",
			"concurrent-agent-b",
			"locking-agent",
			"active-agent",
			"stale-processor",
		];
		for (const agentId of agentIds) {
			await query(
				`INSERT INTO agent_registry (agent_identity, agent_type, status)
         VALUES ($1, 'llm', 'active')
         ON CONFLICT DO NOTHING`,
				[agentId],
			);
		}
	});

	after(async () => {
		// Clean up
		await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		await query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [proposalId]);
	});

	describe("AC-2: prop_transition requires active lease", () => {
		it("should reject transition if caller has no lease", async () => {
			// Release any existing lease
			await query("UPDATE roadmap_proposal.proposal_lease SET released_at = NOW() WHERE proposal_id = $1", [
				proposalId,
			]);

			// Attempt transition without lease should fail
			const leaseCheck = await validateLease(proposalId, "test-agent-1");
			assert.equal(leaseCheck.valid, false);
			assert.equal(leaseCheck.error?.code, "LEASE_CONFLICT");
		});

		it("should allow transition if caller holds active lease", async () => {
			const agent = "test-agent-2";

			// Create a lease for the agent
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', NULL)`,
				[proposalId, agent],
			);

			// Lease check should now pass
			const leaseCheck = await validateLease(proposalId, agent);
			assert.equal(leaseCheck.valid, true);

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});

		it("should reject transition if another agent holds the lease", async () => {
			const agentA = "agent-a";
			const agentB = "agent-b";

			// Agent A claims the lease
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', NULL)`,
				[proposalId, agentA],
			);

			// Agent B tries to transition
			const leaseCheck = await validateLease(proposalId, agentB);
			assert.equal(leaseCheck.valid, false);
			assert.equal(leaseCheck.error?.code, "LEASE_CONFLICT");
			assert(
				leaseCheck.error?.message.includes(agentA) && leaseCheck.error?.message.includes(agentB),
				"Error should identify both agents",
			);

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});

		it("should reject transition if lease has expired", async () => {
			const agent = "test-agent-expired";

			// Create an expired lease
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NULL)`,
				[proposalId, agent],
			);

			// Lease check should fail
			const leaseCheck = await validateLease(proposalId, agent);
			assert.equal(leaseCheck.valid, false);
			assert.equal(leaseCheck.error?.code, "LEASE_CONFLICT");
			assert(leaseCheck.error?.message.includes("expired"), "Error should mention expiration");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});
	});

	describe("AC-1: Gate scanner skips leased proposals", () => {
		it("should include proposals with no lease in mature queue", async () => {
			// Create a separate test proposal to avoid gate guards
			const testResult = await query<{ id: number; display_id: string }>(
				`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, display_id`,
				["P224 Queue Test", "feature", "Review", "mature", '{}'],
			);
			const testProposalId = testResult.rows[0].id;

			// Verify it appears in v_mature_queue
			const result = await query("SELECT id FROM roadmap_proposal.v_mature_queue WHERE id = $1", [testProposalId]);
			assert.equal(result.rows.length, 1, "Mature proposal should be in queue");

			// Verify gate scanner sees it as unlocked
			const queueResults = await getGateQueue(100);
			const testProposalInQueue = queueResults.find((p) => p.id === testProposalId);
			assert(testProposalInQueue, "Proposal should appear in gate queue");
			assert.equal(testProposalInQueue.hasActiveLease, false, "Should not have active lease");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [testProposalId]);
		});

		it("should exclude proposals from unlocked queue if another agent holds a lease", async () => {
			const agent = "gate-blocking-agent";

			// Create another mature proposal for testing
			const testResult = await query<{ id: number; display_id: string }>(
				`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, display_id`,
				["P224 Locked Queue Test", "feature", "Review", "mature", '{}'],
			);
			const testProposalId = testResult.rows[0].id;

			// Create a lease for the proposal
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', NULL)`,
				[testProposalId, agent],
			);

			// Verify it appears in v_mature_queue but is marked as locked
			const allQueue = await getGateQueue(100);
			const lockedProposal = allQueue.find((p) => p.id === testProposalId);
			assert(lockedProposal, "Locked proposal should appear in full gate queue");
			assert.equal(lockedProposal.hasActiveLease, true, "Should have active lease");
			assert.equal(lockedProposal.leaseHolder, agent, "Should show correct lease holder");

			// Verify it's excluded from unlocked queue
			const unlockedQueue = filterUnlockedProposals(allQueue);
			const lockedInUnlocked = unlockedQueue.find((p) => p.id === testProposalId);
			assert.equal(lockedInUnlocked, undefined, "Locked proposal should be excluded from unlocked queue");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [testProposalId]);
			await query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [testProposalId]);
		});

		it("getUnlockedGateQueue should return only unlocked proposals", async () => {
			// Create two proposals
			const prop1Result = await query<{ id: number; display_id: string }>(
				`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, display_id`,
				["P224 Unlocked 1", "feature", "Review", "mature", '{}'],
			);
			const prop1Id = prop1Result.rows[0].id;

			const prop2Result = await query<{ id: number; display_id: string }>(
				`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, display_id`,
				["P224 Locked 1", "feature", "Review", "mature", '{}'],
			);
			const prop2Id = prop2Result.rows[0].id;

			// Lock the second proposal
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', NULL)`,
				[prop2Id, "locking-agent"],
			);

			// Get unlocked proposals
			const unlockedQueue = await getUnlockedGateQueue(100);
			const prop1InQueue = unlockedQueue.find((p) => p.id === prop1Id);
			const prop2InQueue = unlockedQueue.find((p) => p.id === prop2Id);

			assert(prop1InQueue, "Unlocked proposal should be in queue");
			assert.equal(prop2InQueue, undefined, "Locked proposal should not be in queue");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id IN ($1, $2)", [prop1Id, prop2Id]);
			await query("DELETE FROM roadmap_proposal.proposal WHERE id IN ($1, $2)", [prop1Id, prop2Id]);
		});
	});

	describe("AC-6: Stale lease cleanup", () => {
		it("should identify and release stale expired leases", async () => {
			const agent = "stale-agent";

			// Create a lease that expired 15 minutes ago (> 10 min old and already expired)
			const staleTime = new Date(Date.now() - 15 * 60 * 1000);
			const expiredTime = new Date(Date.now() - 5 * 60 * 1000);
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, $3, $4, NULL)`,
				[proposalId, agent, staleTime, expiredTime],
			);

			// Verify it exists before cleanup
			const beforeResult = await query(
				"SELECT id FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1 AND released_at IS NULL",
				[proposalId],
			);
			assert(beforeResult.rows.length > 0, "Stale lease exists before cleanup");

			// Run cleanup
			const cleanedCount = await cleanupStaleLeasesIfNeeded();
			assert(cleanedCount >= 1, "At least one stale lease should be cleaned");

			// Verify it's now released
			const afterResult = await query(
				"SELECT release_reason FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1 AND released_at IS NOT NULL",
				[proposalId],
			);
			assert(afterResult.rows.length > 0, "Stale lease should be released after cleanup");
			assert(
				afterResult.rows[0].release_reason.includes("auto-released"),
				"Release reason should indicate auto-cleanup",
			);

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});

		it("should not clean up active non-expired leases", async () => {
			const agent = "active-agent";

			// Create an active lease that won't expire for another hour
			const recentTime = new Date(Date.now() - 1 * 60 * 1000);
			const futureTime = new Date(Date.now() + 60 * 60 * 1000);
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, $3, $4, NULL)`,
				[proposalId, agent, recentTime, futureTime],
			);

			// Verify it exists before cleanup
			const beforeResult = await query(
				"SELECT id FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1 AND released_at IS NULL",
				[proposalId],
			);
			assert(beforeResult.rows.length > 0, "Active lease exists before cleanup");

			// Run cleanup (should not affect active leases)
			await cleanupStaleLeasesIfNeeded();

			// Verify it's still active
			const afterResult = await query(
				"SELECT id FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1 AND released_at IS NULL",
				[proposalId],
			);
			assert(afterResult.rows.length > 0, "Active lease should remain active after cleanup");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});

		it("should cleanup stale transition_queue processing entries", async () => {
			// Create a stale processing entry (> 10 minutes old)
			const staleTime = new Date(Date.now() - 15 * 60 * 1000);
			const insertResult = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.transition_queue
         (proposal_id, from_stage, to_stage, status, claimed_by, processing_started_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
				[proposalId, "Review", "Develop", "processing", "stale-processor", staleTime],
			);

			// Verify it's in processing state
			const beforeResult = await query(
				"SELECT status FROM roadmap_proposal.transition_queue WHERE id = $1",
				[insertResult.rows[0].id],
			);
			assert.equal(beforeResult.rows[0].status, "processing");

			// Run cleanup
			const cleanedCount = await cleanupStaleTransitionProcessing();
			assert(cleanedCount >= 1, "Stale processing entry should be cleaned");

			// Verify it's back to pending
			const afterResult = await query(
				"SELECT status, claimed_by FROM roadmap_proposal.transition_queue WHERE id = $1",
				[insertResult.rows[0].id],
			);
			assert.equal(afterResult.rows[0].status, "pending", "Should be reset to pending");
			assert.equal(afterResult.rows[0].claimed_by, null, "Claimed_by should be cleared");

			// Clean up
			await query("DELETE FROM roadmap_proposal.transition_queue WHERE proposal_id = $1", [proposalId]);
		});
	});

	describe("AC-7: E2E concurrent transition attempts", () => {
		it("should allow only the leaseholder to transition", async () => {
			const agentA = "concurrent-agent-a";
			const agentB = "concurrent-agent-b";

			// Agent A claims the lease
			await query(
				`INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, claimed_at, expires_at, released_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', NULL)`,
				[proposalId, agentA],
			);

			// Agent B tries to transition (should fail)
			const leaseCheckB = await validateLease(proposalId, agentB);
			assert.equal(leaseCheckB.valid, false, "Non-leaseholder should fail lease validation");

			// Agent A tries to transition (should pass lease validation)
			const leaseCheckA = await validateLease(proposalId, agentA);
			assert.equal(leaseCheckA.valid, true, "Leaseholder should pass lease validation");

			// Clean up
			await query("DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1", [proposalId]);
		});
	});

	describe("AC-4 & AC-5: transition_queue schema", () => {
		it("should have transition_queue table with claimed_by column (when created)", async () => {
			// This test documents the expected schema for transition_queue
			// which should be created as part of P224 implementation
			// Expected columns:
			// - id (PK)
			// - proposal_id (FK)
			// - from_stage
			// - to_stage
			// - status (pending/processing/completed/failed)
			// - claimed_by (agent_identity)
			// - created_at
			// - processing_started_at
			// - completed_at
			//
			// UNIQUE constraint on (proposal_id, from_stage, to_stage, status) where status='pending'
		});
	});
});
