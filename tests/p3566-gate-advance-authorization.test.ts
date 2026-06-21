/**
 * P3566 — Gate-advance authorization integrity (non-terminal gates)
 *
 * Tests the DB guard functions and trigger installed by migration 254.
 *
 * AC-1: fn_guard_gate_advance rejects a non-terminal advance when the only satisfying
 *       approve has reviewer_identity == advancing actor (self-approve blocked).
 * AC-2: Guard rejects advance if an unresolved blocking review exists with
 *       reviewed_at newer than the satisfying approve.
 * AC-3: No review-only bypass — prop_transition on a non-terminal gate without
 *       a gate_decision_log row is rejected (bare approve not sufficient).
 * AC-4: Late-blocking reconcile — blocking review inserted after advance writes
 *       a flagging discussion entry (and optionally sends back under the flag).
 * AC-5: fn_actor_is_independent — shared helper returns correct boolean.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/postgres/pool.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function registerAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, trust_tier, project_id)
		 VALUES ($1, 'tool', 'active', 'restricted', 1)
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

async function createProposal(title: string, status = "DRAFT"): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (title, type, status, maturity, workflow_name, audit)
		 VALUES ($1, 'feature', $2, 'new', 'Standard RFC', '{}')
		 RETURNING id`,
		[title, status],
	);
	return rows[0].id;
}

async function addReview(
	proposalId: number,
	reviewer: string,
	verdict: string,
	isBlocking = false,
	offsetMs = 0,
): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal_reviews
		   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at, project_id)
		 VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, 1)
		 RETURNING id`,
		[proposalId, reviewer, verdict, isBlocking, offsetMs],
	);
	return rows[0].id;
}

async function addGateDecision(
	proposalId: number,
	fromState: string,
	toState: string,
	decidedBy: string,
): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.gate_decision_log
		   (proposal_id, from_state, to_state, gate, decided_by, decision, maturity)
		 VALUES ($1, $2, $3, 'D1', $4, 'advance', 'mature')
		 RETURNING id`,
		[proposalId, fromState, toState, decidedBy],
	);
	return rows[0].id;
}

async function advanceStatus(
	proposalId: number,
	toStatus: string,
	actor: string,
): Promise<void> {
	await query(
		`WITH _actor AS (SELECT set_config('app.agent_identity', $1, true))
		 UPDATE roadmap_proposal.proposal
		    SET status = $2, modified_at = NOW()
		  FROM _actor
		  WHERE id = $3`,
		[actor, toStatus, proposalId],
	);
}

const ACTOR_A = "p3566-test-actor-a";
const ACTOR_B = "p3566-test-reviewer-b";
const ACTOR_C = "p3566-test-reviewer-c";
const TEST_PROP_IDS: number[] = [];

// ─── Test setup ──────────────────────────────────────────────────────────────

before(async () => {
	await registerAgent(ACTOR_A);
	await registerAgent(ACTOR_B);
	await registerAgent(ACTOR_C);
	await registerAgent("system/reconciler");
});

after(async () => {
	// Clean up all proposals created in this test run
	if (TEST_PROP_IDS.length > 0) {
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = ANY($1::bigint[])`,
			[TEST_PROP_IDS],
		);
	}
	// P4387: also remove the synthetic test actor identities so they do not
	// leak into roadmap_workforce.agent_registry as active workers / feed noise.
	// (system/reconciler is a real identity and is intentionally left in place.)
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = ANY($1)`,
		[[ACTOR_A, ACTOR_B, ACTOR_C]],
	);
});

// ─── AC-5: Shared independence helper ────────────────────────────────────────

describe("AC-5: fn_actor_is_independent", () => {
	it("returns FALSE when no approve exists", async () => {
		const pid = await createProposal("P3566 AC-5 no-approve");
		TEST_PROP_IDS.push(pid);

		const { rows } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_actor_is_independent($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(rows[0].result, false, "should return false when no approve exists");
	});

	it("returns FALSE when only approve is from the advancing actor (self-approve)", async () => {
		const pid = await createProposal("P3566 AC-5 self-approve");
		TEST_PROP_IDS.push(pid);
		await addReview(pid, ACTOR_A, "approve");

		const { rows } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_actor_is_independent($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(rows[0].result, false, "self-approve should not count as independent");
	});

	it("returns TRUE when approve from a different actor exists", async () => {
		const pid = await createProposal("P3566 AC-5 independent-approve");
		TEST_PROP_IDS.push(pid);
		await addReview(pid, ACTOR_B, "approve");

		const { rows } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_actor_is_independent($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(rows[0].result, true, "approve from different actor should count as independent");
	});

	it("returns TRUE when advancing actor is null/empty (single-actor degraded mode)", async () => {
		const pid = await createProposal("P3566 AC-5 null-actor");
		TEST_PROP_IDS.push(pid);
		await addReview(pid, ACTOR_A, "approve");

		const { rows } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_actor_is_independent($1, NULL) AS result`,
			[pid],
		);
		assert.equal(rows[0].result, true, "null actor = any approve qualifies (degraded mode)");
	});
});

// ─── AC-1: Self-approve gate rejection ───────────────────────────────────────

describe("AC-1: Independent approver required for non-terminal gate decision", () => {
	it("rejects gate_decision_log INSERT when only approve is from same actor", async () => {
		const pid = await createProposal("P3566 AC-1 self-approve-reject");
		TEST_PROP_IDS.push(pid);

		// Actor A self-approves
		await addReview(pid, ACTOR_A, "approve");

		await assert.rejects(
			async () => {
				await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);
			},
			(err: Error) => {
				assert.ok(
					err.message.includes("independent approve") ||
					err.message.includes("check_violation") ||
					(err as any).code === "23514",
					`Expected check_violation, got: ${err.message}`,
				);
				return true;
			},
			"Self-approve + self-advance should be rejected by BEFORE INSERT trigger",
		);
	});

	it("accepts gate_decision_log INSERT when an independent approve exists", async () => {
		const pid = await createProposal("P3566 AC-1 independent-approve-accept");
		TEST_PROP_IDS.push(pid);

		// Reviewer B approves, Actor A decides gate
		await addReview(pid, ACTOR_B, "approve");
		const decisionId = await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);

		assert.ok(decisionId > 0, "gate_decision_log INSERT should succeed with independent approve");
	});

	it("accepts gate_decision_log INSERT when there is no advancing actor (degraded mode)", async () => {
		const pid = await createProposal("P3566 AC-1 null-actor-accept");
		TEST_PROP_IDS.push(pid);

		// Any approve should work when decided_by is null
		await addReview(pid, ACTOR_A, "approve");
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.gate_decision_log
			   (proposal_id, from_state, to_state, gate, decided_by, decision, maturity)
			 VALUES ($1, 'DRAFT', 'REVIEW', 'D1', NULL, 'advance', 'mature')
			 RETURNING id`,
			[pid],
		);
		assert.ok(rows[0].id > 0, "null decided_by should work in degraded mode");
	});
});

// ─── AC-2: Unresolved blocking review blocks advance ─────────────────────────

describe("AC-2: Unresolved blocking review blocks non-terminal gate advance", () => {
	it("rejects advance when blocking review exists with no superseding approve", async () => {
		const pid = await createProposal("P3566 AC-2 blocking-no-supersede");
		TEST_PROP_IDS.push(pid);

		// Independent approve (t=0), then blocking review (t=+100ms)
		await addReview(pid, ACTOR_B, "approve", false, 0);
		await addReview(pid, ACTOR_C, "request_changes", true, 100);

		await assert.rejects(
			async () => {
				await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);
			},
			(err: Error) => {
				assert.ok(
					err.message.includes("blocking") ||
					(err as any).code === "23514",
					`Expected blocking check_violation, got: ${err.message}`,
				);
				return true;
			},
			"Blocking review newer than approve should block advance",
		);
	});

	it("accepts advance when blocking review is superseded by later independent approve", async () => {
		const pid = await createProposal("P3566 AC-2 blocking-superseded");
		TEST_PROP_IDS.push(pid);

		// blocking review (t=0), then independent approve (t=+100ms) — supersedes blocking
		await addReview(pid, ACTOR_C, "request_changes", true, 0);
		await addReview(pid, ACTOR_B, "approve", false, 100);

		const decisionId = await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);
		assert.ok(decisionId > 0, "Blocking review superseded by later approve should allow advance");
	});

	it("accepts advance when only approve exists (no blocking reviews)", async () => {
		const pid = await createProposal("P3566 AC-2 no-blocking");
		TEST_PROP_IDS.push(pid);

		await addReview(pid, ACTOR_B, "approve");
		const decisionId = await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);
		assert.ok(decisionId > 0, "No blocking reviews: advance should succeed");
	});

	it("fn_has_unresolved_blocking returns correct values", async () => {
		const pid = await createProposal("P3566 AC-2 fn_has_unresolved_blocking");
		TEST_PROP_IDS.push(pid);

		// Initially no blocking
		const { rows: r0 } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_has_unresolved_blocking($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(r0[0].result, false, "no reviews → not blocking");

		// Add blocking review
		await addReview(pid, ACTOR_C, "request_changes", true, 0);

		const { rows: r1 } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_has_unresolved_blocking($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(r1[0].result, true, "blocking review → has_blocking=true");

		// Supersede with independent approve
		await addReview(pid, ACTOR_B, "approve", false, 100);

		const { rows: r2 } = await query<{ result: boolean }>(
			`SELECT roadmap.fn_has_unresolved_blocking($1, $2) AS result`,
			[pid, ACTOR_A],
		);
		assert.equal(r2[0].result, false, "after superseding approve → has_blocking=false");
	});
});

// ─── AC-3: No review-only bypass — gate_decision_log required ────────────────

describe("AC-3: prop_transition on non-terminal gate requires gate_decision_log row", () => {
	it("rejects DRAFT→REVIEW via prop_transition when no gate_decision_log row exists", async () => {
		const pid = await createProposal("P3566 AC-3 no-log-reject");
		TEST_PROP_IDS.push(pid);

		// Add independent approve but NO gate_decision_log row
		await addReview(pid, ACTOR_B, "approve");

		await assert.rejects(
			async () => {
				await advanceStatus(pid, "REVIEW", ACTOR_A);
			},
			(err: Error) => {
				assert.ok(
					err.message.includes("gate decision") ||
					err.message.includes("INDEPENDENT") ||
					(err as any).code === "23514",
					`Expected gate guard rejection, got: ${err.message}`,
				);
				return true;
			},
			"prop_transition without gate_decision_log should be rejected for non-terminal gate",
		);
	});

	it("accepts DRAFT→REVIEW via prop_transition when gate_decision_log row with bypass exists", async () => {
		const pid = await createProposal("P3566 AC-3 bypass-accept");
		TEST_PROP_IDS.push(pid);

		// The normal gate_decision path uses bypass=true (fn_apply_gate_advance).
		// Simulate the bypass path:
		await query(
			`SET LOCAL app.gate_bypass = 'true'`,
		);
		// Use a transaction to keep SET LOCAL in scope
		await query(`BEGIN`);
		try {
			await query(`SET LOCAL app.gate_bypass = 'true'`);
			await query(
				`UPDATE roadmap_proposal.proposal SET status = 'REVIEW', modified_at = NOW()
				 WHERE id = $1`,
				[pid],
			);
			await query(`COMMIT`);
		} catch (e) {
			await query(`ROLLBACK`);
			throw e;
		}

		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].status.toUpperCase(), "REVIEW");
	});

	it("accepts DRAFT→REVIEW via gate_decision_log INSERT path (AC-3 canonical path)", async () => {
		const pid = await createProposal("P3566 AC-3 canonical-path");
		TEST_PROP_IDS.push(pid);

		// 1. Independent reviewer approves
		await addReview(pid, ACTOR_B, "approve");

		// 2. Gate decider inserts into gate_decision_log (triggers fn_apply_gate_advance)
		const decisionId = await addGateDecision(pid, "DRAFT", "REVIEW", ACTOR_A);
		assert.ok(decisionId > 0, "gate_decision_log INSERT should succeed");

		// 3. Proposal should now be in REVIEW (fn_apply_gate_advance fires AFTER INSERT)
		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(
			rows[0].status.toUpperCase(),
			"REVIEW",
			"Proposal should advance to REVIEW after gate_decision_log INSERT",
		);
	});
});

// ─── AC-4: Late-blocking-review reconcile ────────────────────────────────────

describe("AC-4: Late-blocking reconcile — flag when blocking review filed after advance", () => {
	it("writes discussion entry when blocking review is inserted after advance to DEVELOP", async () => {
		// Arrange: proposal already in DEVELOP
		const pid = await createProposal("P3566 AC-4 late-block-flag", "DEVELOP");
		TEST_PROP_IDS.push(pid);

		// Act: insert a blocking review for this already-advanced proposal
		await addReview(pid, ACTOR_C, "request_changes", true, 0);

		// Assert: a discussion entry flagging the late blocking review should exist
		const { rows } = await query<{ body: string; context_prefix: string }>(
			`SELECT body, context_prefix
			   FROM roadmap_proposal.proposal_discussions
			  WHERE proposal_id = $1
			    AND context_prefix = 'gate-late-block:'
			  ORDER BY id DESC LIMIT 1`,
			[pid],
		);

		assert.ok(rows.length > 0, "A late-block flag discussion entry should exist");
		assert.ok(
			rows[0].body.includes("LATE BLOCKING REVIEW"),
			`Expected 'LATE BLOCKING REVIEW' in body, got: ${rows[0].body}`,
		);
	});

	it("does NOT flag when blocking review is inserted for a proposal still in REVIEW", async () => {
		// Arrange: proposal still in REVIEW (has not yet advanced)
		const pid = await createProposal("P3566 AC-4 still-in-review", "REVIEW");
		TEST_PROP_IDS.push(pid);

		// Act: insert a blocking review
		await addReview(pid, ACTOR_C, "request_changes", true, 0);

		// Assert: no late-block discussion entry (proposal is still in REVIEW, not beyond)
		const { rows } = await query<{ id: number }>(
			`SELECT id FROM roadmap_proposal.proposal_discussions
			  WHERE proposal_id = $1 AND context_prefix = 'gate-late-block:'`,
			[pid],
		);
		assert.equal(rows.length, 0, "No late-block flag for proposal still in REVIEW");
	});

	it("does NOT flag for non-blocking reviews on advanced proposals", async () => {
		const pid = await createProposal("P3566 AC-4 non-blocking", "DEVELOP");
		TEST_PROP_IDS.push(pid);

		// Non-blocking comment-type review
		await addReview(pid, ACTOR_C, "approve", false, 0);

		const { rows } = await query<{ id: number }>(
			`SELECT id FROM roadmap_proposal.proposal_discussions
			  WHERE proposal_id = $1 AND context_prefix = 'gate-late-block:'`,
			[pid],
		);
		assert.equal(rows.length, 0, "No late-block flag for non-blocking reviews");
	});
});
