// @ts-nocheck — SqliteStore feature not implemented (TODO: implement or remove 2026-04-01)
/**
 * Tests for Fluid Proposal Machine - Multi-Phase Lifecycle with Test & Claim Tracking (proposal-80)
 *
 * AC#1: Proposals can transition to ANY phase (not just forward)
 * AC#2: Test cases stored in DB: id, proposal_id, ac_number, description
 * AC#3: Test results stored in DB: test_case_id, status, agent, timestamp, evidence
 * AC#4: Claim log tracks all actions: who did what, when, on which proposal
 * AC#5: Phase history enables debugging: 'Why did proposal-46 go back to design?'
 * AC#6: PMs forced to enrich definitions when proposals bounce back to research
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

describe("proposal-80: Fluid Proposal Machine", () => {
	let tempDir: string;
	let store: SqliteStore;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-proposal80-test-"));
	});

	beforeEach(async () => {
		store = new SqliteStore(tempDir);
		await store.ensureInitialized();

		// Create a test proposal
		store.upsertProposal(
			{
				id: "proposal-80",
				title: "Fluid Proposal Machine",
				status: "Active",
				assignee: ["senior-developer-49"],
				labels: ["database", "proposal-machine"],
				dependencies: [],
			},
			Date.now(),
			"Test proposal body",
		);
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#1: Proposals can transition to ANY phase ──────────────────────

	describe("AC#1: Bidirectional phase transitions", () => {
		it("should allow forward transitions (Research → Design)", () => {
			const id = store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
				"Research complete, moving to design",
			);
			assert.ok(id, "Should return transition ID");

			const history = store.getPhaseHistory("proposal-80");
			assert.equal(history.length, 1);
			assert.equal(history[0].from_phase, "Research");
			assert.equal(history[0].to_phase, "Design");
		});

		it("should allow backward transitions (Design → Research)", () => {
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			const id = store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-002",
				"Requirements changed, need more research",
			);
			assert.ok(id, "Should allow backward transition");

			const history = store.getPhaseHistory("proposal-80");
			assert.equal(history.length, 2);
			assert.equal(history[0].to_phase, "Research"); // Most recent first
		});

		it("should allow arbitrary phase jumps (Review → Implementation)", () => {
			const id = store.recordPhaseTransition(
				"proposal-80",
				"Review",
				"Implementation",
				"agent-001",
				"Reviewer requested implementation changes",
			);
			assert.ok(id, "Should allow non-sequential transition");
		});

		it("should allow same-phase transitions", () => {
			const id = store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Design",
				"agent-001",
				"Design revision",
			);
			assert.ok(id, "Should allow same-phase transition");
		});
	});

	// ─── AC#2: Test cases stored in DB ─────────────────────────────────

	describe("AC#2: Test cases in database", () => {
		it("should store test cases with id, proposal_id, ac_number, description", () => {
			const id = store.addTestCase(
				"proposal-80",
				1,
				"Verify proposal transitions work correctly",
			);
			assert.ok(id, "Should return test case ID");

			const tc = store.getTestCase(id);
			assert.ok(tc, "Should retrieve test case");
			assert.equal(tc.proposal_id, "proposal-80");
			assert.equal(tc.ac_number, 1);
			assert.equal(
				tc.description,
				"Verify proposal transitions work correctly",
			);
		});

		it("should store multiple test cases per proposal", () => {
			store.addTestCase("proposal-80", 1, "Test AC#1");
			store.addTestCase("proposal-80", 2, "Test AC#2");
			store.addTestCase("proposal-80", 3, "Test AC#3");

			const tcs = store.getTestCases("proposal-80");
			assert.equal(tcs.length, 3);
			assert.equal(tcs[0].ac_number, 1);
			assert.equal(tcs[2].ac_number, 3);
		});

		it("should order test cases by ac_number", () => {
			store.addTestCase("proposal-80", 3, "Test AC#3");
			store.addTestCase("proposal-80", 1, "Test AC#1");
			store.addTestCase("proposal-80", 2, "Test AC#2");

			const tcs = store.getTestCases("proposal-80");
			assert.equal(tcs[0].ac_number, 1);
			assert.equal(tcs[1].ac_number, 2);
			assert.equal(tcs[2].ac_number, 3);
		});

		it("should delete test case by ID", () => {
			const id = store.addTestCase("proposal-80", 1, "Test to delete");
			assert.ok(store.deleteTestCase(id), "Should return true on delete");
			assert.equal(
				store.getTestCase(id),
				null,
				"Should not find deleted test case",
			);
		});
	});

	// ─── AC#3: Test results stored in DB ───────────────────────────────

	describe("AC#3: Test results in database", () => {
		let testCaseId: string;

		beforeEach(() => {
			testCaseId = store.addTestCase("proposal-80", 1, "Test for results");
		});

		it("should store test results with status, agent, timestamp, evidence", () => {
			const id = store.recordTestResult(
				testCaseId,
				"passed",
				"agent-001",
				"CLI output: all checks passed",
				150,
			);
			assert.ok(id, "Should return result ID");

			const results = store.getTestResults(testCaseId);
			assert.equal(results.length, 1);
			assert.equal(results[0].status, "passed");
			assert.equal(results[0].agent, "agent-001");
			assert.equal(results[0].evidence, "CLI output: all checks passed");
			assert.equal(results[0].duration_ms, 150);
			assert.ok(results[0].timestamp, "Should have timestamp");
		});

		it("should support all status types", () => {
			store.recordTestResult(testCaseId, "passed", "agent-001");
			store.recordTestResult(
				testCaseId,
				"failed",
				"agent-002",
				"Expected 5 got 3",
			);
			store.recordTestResult(testCaseId, "skipped", "agent-003");
			store.recordTestResult(
				testCaseId,
				"error",
				"agent-004",
				undefined,
				undefined,
				"Timeout",
			);

			const results = store.getTestResults(testCaseId);
			assert.equal(results.length, 4);
			const statuses = results.map((r: any) => r.status);
			assert.ok(statuses.includes("passed"));
			assert.ok(statuses.includes("failed"));
			assert.ok(statuses.includes("skipped"));
			assert.ok(statuses.includes("error"));
		});

		it("should return results in reverse chronological order", async () => {
			store.recordTestResult(testCaseId, "passed", "agent-001");
			await new Promise((r) => setTimeout(r, 10)); // Ensure different timestamps
			store.recordTestResult(testCaseId, "failed", "agent-002");
			await new Promise((r) => setTimeout(r, 10));
			store.recordTestResult(testCaseId, "passed", "agent-003");

			const results = store.getTestResults(testCaseId);
			assert.equal(results[0].agent, "agent-003", "Most recent first");
		});

		it("should support result limit", () => {
			store.recordTestResult(testCaseId, "passed", "agent-001");
			store.recordTestResult(testCaseId, "passed", "agent-002");
			store.recordTestResult(testCaseId, "passed", "agent-003");

			const results = store.getTestResults(testCaseId, 2);
			assert.equal(results.length, 2);
		});

		it("should aggregate proposal test summary", () => {
			const tc2 = store.addTestCase("proposal-80", 2, "Second test");
			store.recordTestResult(testCaseId, "passed", "agent-001");
			store.recordTestResult(testCaseId, "failed", "agent-002");
			store.recordTestResult(tc2, "passed", "agent-003");
			store.recordTestResult(tc2, "skipped", "agent-004");

			const summary = store.getProposalTestSummary("proposal-80");
			assert.equal(summary.total, 4);
			assert.equal(summary.passed, 2);
			assert.equal(summary.failed, 1);
			assert.equal(summary.skipped, 1);
			assert.equal(summary.errors, 0);
			assert.ok(summary.lastRun, "Should have last run timestamp");
		});

		it("should get results for a proposal via getProposalTestResults", () => {
			store.recordTestResult(testCaseId, "passed", "agent-001", "evidence");
			const results = store.getProposalTestResults("proposal-80");
			assert.equal(results.length, 1);
			assert.equal(results[0].ac_number, 1);
			assert.equal(results[0].test_description, "Test for results");
		});
	});

	// ─── AC#4: Claim log tracks all actions ────────────────────────────

	describe("AC#4: Claim log", () => {
		it("should log actions with agent, action, timestamp", () => {
			const id = store.logClaimAction(
				"proposal-80",
				"senior-developer-49",
				"claimed",
				"Started implementation",
			);
			assert.ok(id, "Should return log ID");

			const log = store.getClaimLog("proposal-80");
			assert.equal(log.length, 1);
			assert.equal(log[0].agent, "senior-developer-49");
			assert.equal(log[0].action, "claimed");
			assert.equal(log[0].details, "Started implementation");
			assert.ok(log[0].timestamp, "Should have timestamp");
		});

		it("should log multiple actions for a proposal", () => {
			store.logClaimAction("proposal-80", "agent-001", "claimed");
			store.logClaimAction("proposal-80", "agent-001", "started");
			store.logClaimAction("proposal-80", "agent-002", "reviewed");
			store.logClaimAction("proposal-80", "agent-001", "completed");

			const log = store.getClaimLog("proposal-80");
			assert.equal(log.length, 4);
		});

		it("should return claim log in reverse chronological order", async () => {
			store.logClaimAction("proposal-80", "agent-001", "first");
			await new Promise((r) => setTimeout(r, 10));
			store.logClaimAction("proposal-80", "agent-002", "second");
			await new Promise((r) => setTimeout(r, 10));
			store.logClaimAction("proposal-80", "agent-003", "third");

			const log = store.getClaimLog("proposal-80");
			assert.equal(log[0].action, "third");
		});

		it("should get agent-specific claim log", () => {
			store.logClaimAction("proposal-80", "agent-001", "action-a");
			store.logClaimAction("proposal-80", "agent-002", "action-b");
			store.logClaimAction("proposal-80", "agent-001", "action-c");

			const agentLog = store.getAgentClaimLog("agent-001");
			assert.equal(agentLog.length, 2);
			assert.ok(agentLog.every((e: any) => e.agent === "agent-001"));
		});

		it("should support claim log limit", () => {
			store.logClaimAction("proposal-80", "agent-001", "action-1");
			store.logClaimAction("proposal-80", "agent-001", "action-2");
			store.logClaimAction("proposal-80", "agent-001", "action-3");

			const log = store.getClaimLog("proposal-80", 2);
			assert.equal(log.length, 2);
		});
	});

	// ─── AC#5: Phase history enables debugging ─────────────────────────

	describe("AC#5: Phase history for debugging", () => {
		it("should record phase transitions with reason", () => {
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
				"Research complete",
			);

			const history = store.getPhaseHistory("proposal-80");
			assert.equal(history.length, 1);
			assert.equal(history[0].reason, "Research complete");
		});

		it("should find backward transitions for debugging", () => {
			// Forward
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Implementation",
				"agent-001",
			);
			// Backward - this is what we're debugging
			store.recordPhaseTransition(
				"proposal-80",
				"Implementation",
				"Design",
				"agent-002",
				"AC not properly defined",
			);

			const backward = store.getBackwardTransitions("proposal-80");
			assert.equal(backward.length, 1);
			assert.equal(backward[0].from_phase, "Implementation");
			assert.equal(backward[0].to_phase, "Design");
			assert.equal(backward[0].reason, "AC not properly defined");
		});

		it("should answer 'Why did proposal-X go back to Research?'", () => {
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Review",
				"agent-002",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Review",
				"Research",
				"agent-003",
				"Stakeholder requested scope change",
			);

			const history = store.getPhaseHistory("proposal-80");
			const researchBounce = history.find(
				(h: any) => h.to_phase === "Research" && h.from_phase !== "Research",
			);
			assert.ok(researchBounce, "Should find the bounce-back to Research");
			assert.equal(researchBounce.reason, "Stakeholder requested scope change");
		});

		it("should find all backward transitions across proposals", () => {
			// Proposal 80 backward
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-001",
			);

			// Create another proposal
			store.upsertProposal(
				{
					id: "proposal-81",
					title: "Another Proposal",
					status: "Active",
					assignee: ["agent-002"],
					labels: [],
					dependencies: [],
				},
				Date.now(),
				"Test",
			);
			store.recordPhaseTransition(
				"proposal-81",
				"Implementation",
				"Design",
				"agent-002",
			);

			const allBackward = store.getBackwardTransitions();
			assert.equal(allBackward.length, 2);
		});
	});

	// ─── AC#6: PM enrichment on bounce-back ────────────────────────────

	describe("AC#6: Proposals bounced back to research", () => {
		it("should identify proposals that bounced back to research", () => {
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-002",
				"Requirements unclear",
			);

			const bounced = store.getProposalsBouncedToResearch();
			assert.equal(bounced.length, 1);
			assert.equal(bounced[0].proposal_id, "proposal-80");
			assert.ok(bounced[0].reasons.includes("Requirements unclear"));
		});

		it("should track multiple bounce reasons", () => {
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-002",
				"First reason",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-003",
				"Second reason",
			);

			const bounced = store.getProposalsBouncedToResearch();
			assert.equal(bounced.length, 1);
			assert.ok(bounced[0].reasons.includes("First reason"));
			assert.ok(bounced[0].reasons.includes("Second reason"));
		});

		it("should not include proposals that only went forward to research", () => {
			// Set up proposal-80 with a backward bounce to Research
			store.recordPhaseTransition(
				"proposal-80",
				"Research",
				"Design",
				"agent-001",
			);
			store.recordPhaseTransition(
				"proposal-80",
				"Design",
				"Research",
				"agent-002",
				"Needs rework",
			);

			// Create a new proposal with only forward transition to Research
			store.upsertProposal(
				{
					id: "proposal-82",
					title: "Fresh Proposal",
					status: "Active",
					assignee: ["agent-001"],
					labels: [],
					dependencies: [],
				},
				Date.now(),
				"Test",
			);
			// Only forward to research (start) - should NOT be counted as bounce
			store.recordPhaseTransition(
				"proposal-82",
				"Potential",
				"Research",
				"agent-001",
			);

			const bounced = store.getProposalsBouncedToResearch();
			assert.equal(bounced.length, 1); // Only proposal-80 should be here
			assert.equal(bounced[0].proposal_id, "proposal-80");
		});
	});
});
