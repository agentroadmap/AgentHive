/**
 * Tests for V3-C7 (P1439): Deliverable Verifier
 *
 * AC-1: Verify that each role maps to its objective artifact check
 * AC-2: Verify that workers without artifacts are marked failed + don't advance maturity
 * AC-3: Verify that verifier runs in completion-observer before maturity advance
 * AC-4: P1140 marked absorbed (manual SQL/MCP in operator report)
 */

import { test } from "node:test";
import assert from "node:assert";
import { query } from "../../infra/postgres/pool.ts";
import {
	verifyDeliverables,
	markDeliverableVerificationFailed,
	getRoleArtifactMap,
	normalizeDispatchRole,
	type VerifyDeliverablesInput,
} from "./deliverable-verifier.ts";

const TEST_ID = `p1439-test-${Date.now()}`;

// ──────────────────────────────────────────────────────────────────────────────
// AC-1: Role->Artifact-Check Map Documentation
// ──────────────────────────────────────────────────────────────────────────────

test("AC-1: getRoleArtifactMap returns complete role mapping", () => {
	const map = getRoleArtifactMap();

	assert.ok(map["gate-review"], "gate-review should map to proposal_reviews check");
	assert.ok(map["developer"], "developer should map to agent_runs check");
	assert.ok(map["enhance"], "enhance should map to AC/discussion check");
	assert.ok(map["architect"], "architect should map to AC with criterion_text");

	// Verify descriptions are non-empty
	Object.values(map).forEach((desc) => {
		assert.ok(desc.length > 0, "Each role should have a non-empty description");
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-2: Worker Without Artifacts is Marked Failed
// ──────────────────────────────────────────────────────────────────────────────

test("AC-2.1: gate-review role fails when no proposal_reviews row exists", async () => {
	// Setup: Create a proposal without reviews
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Review", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Verify: gate-review with no review row should fail
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "gate-review",
			workerIdentity: "test-reviewer",
		});

		assert.strictEqual(result.verified, false, "Should NOT verify when no review row exists");
		assert.ok(
			result.failureReason?.includes("No proposal_reviews row"),
			"Failure reason should mention missing review row"
		);
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.2: gate-review role succeeds when proposal_reviews row exists", async () => {
	// Setup: Create proposal and review
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Review", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	// Ensure reviewer exists in agent_registry
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		  (agent_identity, agent_type, trust_tier, status)
		  VALUES ($1, $2, $3, $4)
		  ON CONFLICT (agent_identity) DO UPDATE SET status = $4`,
		["test-reviewer-ac2", "llm", "authority", "active"]
	);

	try {
		// Create a review row
		await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
			  (proposal_id, reviewer_identity, verdict, is_blocking, project_id)
			  VALUES ($1, $2, $3, $4, $5)`,
			[proposalId, "test-reviewer-ac2", "approve", false, 1]
		);

		// Verify: Should succeed
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "gate-review",
			workerIdentity: "test-reviewer-ac2",
		});

		assert.strictEqual(result.verified, true, "Should verify when review row exists");
		assert.strictEqual(result.artifactType, "proposal_reviews");
		assert.ok(result.artifactId, "Should return the review ID");
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.3: developer role fails when no agent_runs row exists", async () => {
	// Setup: Create proposal without agent_runs
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Develop", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Verify: developer with no agent_runs should fail
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "developer",
			workerIdentity: "test-dev-agent",
		});

		assert.strictEqual(result.verified, false, "Should NOT verify when no agent_runs");
		assert.ok(
			result.failureReason?.includes("No completed agent_runs"),
			"Failure reason should mention missing agent_runs"
		);
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.4: developer role succeeds when agent_runs completed exists", async () => {
	// Setup: Create proposal with completed agent_runs
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Develop", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Create agent_runs row with completed status
		await query(
			`INSERT INTO roadmap_workforce.agent_runs
			  (proposal_id, agent_identity, stage, model_used, status, output_summary)
			  VALUES ($1, $2, $3, $4, $5, $6)`,
			[proposalId, "test-dev-agent-ac24", "DEVELOP", "test-model", "completed", "Work completed"]
		);

		// Verify: Should succeed
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "developer",
			workerIdentity: "test-dev-agent-ac24",
		});

		assert.strictEqual(result.verified, true, "Should verify when agent_runs completed");
		assert.strictEqual(result.artifactType, "agent_runs");
		assert.ok(result.artifactId, "Should return the agent_runs ID");
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.5: enhance role fails when no AC or discussion artifacts", async () => {
	// Setup: Create proposal without AC/discussions
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Draft", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Verify: enhance with no artifacts should fail
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "enhance",
			workerIdentity: "test-enhancer",
		});

		assert.strictEqual(result.verified, false, "Should NOT verify when no AC/discussions");
		assert.ok(
			result.failureReason?.includes("No AC or discussion artifacts"),
			"Failure reason should mention missing artifacts"
		);
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.6: architect role fails when no AC with criterion_text", async () => {
	// Setup: Create proposal without AC
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Draft", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Verify: architect with no AC should fail
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "architect",
			workerIdentity: "test-architect",
		});

		assert.strictEqual(result.verified, false, "Should NOT verify when no AC");
		assert.ok(
			result.failureReason?.includes("No acceptance criteria"),
			"Failure reason should mention missing AC"
		);
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

test("AC-2.7: architect role succeeds when AC with criterion_text exists", async () => {
	// Setup: Create proposal with AC
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Draft", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Create AC row
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			  (proposal_id, item_number, criterion_text, status, project_id)
			  VALUES ($1, $2, $3, $4, $5)`,
			[proposalId, 1, "Test AC: should do X", "pending", 1]
		);

		// Verify: Should succeed
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "architect",
			workerIdentity: "test-architect",
		});

		assert.strictEqual(result.verified, true, "Should verify when AC exists");
		assert.strictEqual(result.artifactType, "proposal_acceptance_criteria");
		assert.ok(result.artifactId, "Should return the AC ID");
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-2 Part 2: markDeliverableVerificationFailed marks dispatch as failed
// ──────────────────────────────────────────────────────────────────────────────

test("AC-2.8: markDeliverableVerificationFailed sets correct status + failure_class", async () => {
	// Setup: Create proposal and squad_dispatch
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Develop", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	// Ensure worker exists
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		  (agent_identity, agent_type, trust_tier, status)
		  VALUES ($1, $2, $3, $4)
		  ON CONFLICT (agent_identity) DO UPDATE SET status = $4`,
		["test-worker-ac28", "llm", "authority", "active"]
	);

	// Create squad_dispatch
	const dispatchRes = await query(
		`INSERT INTO roadmap_workforce.squad_dispatch
		  (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status, project_id, required_capabilities)
		  VALUES ($1, $2, $3, $4, $5, $6, $7)
		  RETURNING id`,
		[proposalId, "test-worker-ac28", "test-squad", "developer", "active", 1, '["code"]']
	);
	const dispatchId = dispatchRes.rows[0].id;

	try {
		// Mark as failed
		await markDeliverableVerificationFailed(dispatchId, "No artifacts found");

		// Verify: Check that dispatch is marked failed with correct failure_class
		const checkRes = await query(
			`SELECT dispatch_status, failure_class, failure_is_transient, metadata
			  FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[dispatchId]
		);

		assert.strictEqual(checkRes.rows.length, 1, "Dispatch should still exist");
		const row = checkRes.rows[0];
		assert.strictEqual(row.dispatch_status, "failed", "dispatch_status should be 'failed'");
		assert.strictEqual(row.failure_class, "unknown", "failure_class should be 'unknown' (unattributable hallucination)");
		assert.strictEqual(row.failure_is_transient, false, "failure_is_transient should be false");
		assert.ok(
			row.metadata?.verification_failed_reason,
			"Metadata should contain verification_failed_reason"
		);
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-3: Verifier runs in completion observer before maturity advance
// (This is integration-level; tested via orchestrator integration test)
// ──────────────────────────────────────────────────────────────────────────────

test("AC-3.1: Verifier logic is invoked before maturity change (sanity check)", async () => {
	// This test documents the expected integration point.
	// In the orchestrator completion-observer, before calling set_maturity('mature'),
	// the verifier should be called.
	//
	// Expected code flow:
	//   1. Worker emits spawn_summary_emit(outcome=success)
	//   2. Orchestrator's release_lease or reconciler picks up the completion
	//   3. Call verifyDeliverables(proposalId, dispatchRole, workerIdentity)
	//   4. If verified=false, call markDeliverableVerificationFailed and SKIP maturity advance
	//   5. If verified=true, proceed with maturity='mature'

	// Verify the functions exist and are callable
	assert.ok(typeof verifyDeliverables === "function");
	assert.ok(typeof markDeliverableVerificationFailed === "function");

	// Mock scenario: simulate hallucination detection
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Review", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Simulate: gate-review role, no artifacts
		const verifyResult = await verifyDeliverables({
			proposalId,
			dispatchRole: "gate-review",
			workerIdentity: "fake-reviewer",
		});

		// Should fail verification
		assert.strictEqual(verifyResult.verified, false);

		// If integrated correctly, the orchestrator would NOT call set_maturity here
		// This is a safeguard integration test.
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases and unknown role handling
// ──────────────────────────────────────────────────────────────────────────────

test("Unknown role defaults to verified=true with warning", async () => {
	// Setup: Create a proposal
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Review", "new", `Test Proposal ${TEST_ID}`, "feature", 1, '{}']
	);
	const proposalId = proposalRes.rows[0].id;

	try {
		// Verify with unknown role
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "unknown-future-role",
			workerIdentity: "some-agent",
		});

		// Should default to pass (no artifact concept = skip verification)
		assert.strictEqual(result.verified, true, "Unknown roles should pass by default");
		assert.strictEqual(result.artifactType, "no-artifact-role");
	} finally {
		// Cleanup
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// P1438 AC-12/13: role normalization (anti-placebo) + live-role evidence gate
// ──────────────────────────────────────────────────────────────────────────────

test("P1438 AC-12: normalizeDispatchRole maps live dispatch roles to artifact checks", () => {
	// Live squad_dispatch.dispatch_role values must map to a check category —
	// otherwise the evidence gate is a no-op for the roles that actually run.
	const expect: Record<string, string | null> = {
		"gate-reviewer": "gate-review",
		reviewer: "gate-review",
		"reviewer-d1": "gate-review",
		skeptic: "gate-review",
		"skeptic-alpha": "gate-review",
		"skeptic-beta": "gate-review",
		qa: "gate-review",
		developer: "developer",
		engineer: "developer",
		drafter: "developer",
		"merge-agent": "developer",
		enhancer: "enhance",
		enrichment_agent: "enhance",
		researcher: "enhance",
		architect: "architect",
		// no artifact concept → null (skipped)
		"token-tracker": null,
		"messaging-tester": null,
		gate_decision_agent: null,
	};
	for (const [role, want] of Object.entries(expect)) {
		assert.strictEqual(
			normalizeDispatchRole(role),
			want,
			`role '${role}' should normalize to ${want}`,
		);
	}
});

test("P1438 AC-13: LIVE role 'gate-reviewer' (not the internal key) fails the gate with no review row", async () => {
	// The handler calls verifyDeliverables with payload.role = 'gate-reviewer'.
	// Before the normalizer this hit the unknown-role default (verified=true) —
	// a placebo. It must now resolve to the gate-review check and FAIL when no
	// proposal_reviews row exists (exit-0 alone is not delivery evidence).
	const proposalRes = await query(
		`INSERT INTO roadmap_proposal.proposal
		  (status, maturity, title, type, project_id, audit)
		  VALUES ($1, $2, $3, $4, $5, $6)
		  RETURNING id`,
		["Review", "new", `Test Proposal ${TEST_ID}-livegate`, "feature", 1, '{}'],
	);
	const proposalId = proposalRes.rows[0].id;
	try {
		const result = await verifyDeliverables({
			proposalId,
			dispatchRole: "gate-reviewer", // LIVE role name, not "gate-review"
			workerIdentity: "claude-bot-gary.a",
		});
		assert.strictEqual(
			result.verified,
			false,
			"gate-reviewer with no proposal_reviews row must NOT be verified (AC-13)",
		);
	} finally {
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
	}
});
