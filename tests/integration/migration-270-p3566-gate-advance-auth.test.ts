/**
 * Integration tests for migration 270 — P3566 gate-advance authorization integrity.
 *
 * Tests:
 *   AC-1: fn_guard_gate_advance rejects direct non-terminal advance when no gate_decision_log row.
 *         fn_apply_gate_advance rejects when no independent approve (reviewer == decided_by).
 *         fn_apply_gate_advance accepts when independent approve exists (reviewer != decided_by).
 *
 *   AC-2: fn_apply_gate_advance rejects when a newer blocking review exists after independent approve.
 *         fn_apply_gate_advance accepts when blocking review is superseded by a later independent approve.
 *
 *   AC-3: Direct UPDATE on DRAFT→REVIEW (no bypass) raises check_violation.
 *         Advance via gate_decision_log succeeds (fn_apply_gate_advance sets bypass).
 *
 *   AC-4: Blocking review inserted after advance → flagged discussion with 'gate-toctou-flag:' prefix.
 *
 *   AC-5: fn_actor_is_independent returns true for distinct non-empty identities,
 *         false for same identity / null / empty.
 *
 * Uses a real Postgres connection — no mocks.
 * Requires: migration 270 applied, agent_registry entries for test actors.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ??
	"postgresql://admin@127.0.0.1:5432/agenthive";

const ADVANCER = "test-p3566-advancer";
const REVIEWER = "test-p3566-reviewer";
const BLOCKER  = "test-p3566-blocker";

let pool: Pool;

async function insertTestProposal(status: string, title: string): Promise<number> {
	const displayId = `P3566-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, status, maturity, type, project_id, audit)
		 VALUES ($1, $2, $3, 'new', 'feature', 1,
		         '{"created_by":"test","created_at":"2026-01-01"}'::jsonb)
		 RETURNING id`,
		[displayId, title, status],
	);
	return rows[0]!.id;
}

async function insertReview(opts: {
	proposalId: number;
	reviewer: string;
	verdict: string;
	isBlocking?: boolean;
}): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_proposal.proposal_reviews
		     (proposal_id, reviewer_identity, verdict, is_blocking, notes)
		 VALUES ($1, $2, $3, $4, 'P3566 test review')`,
		[opts.proposalId, opts.reviewer, opts.verdict, opts.isBlocking ?? false],
	);
}

async function insertGDL(opts: {
	proposalId: number;
	fromState: string;
	toState: string;
	decision: string;
	decidedBy: string;
}): Promise<number> {
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.gate_decision_log
		     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale)
		 VALUES ($1, $2, $3, $4, $5, $6, 'P3566 integration test')
		 RETURNING id`,
		[
			opts.proposalId,
			opts.fromState,
			opts.toState,
			opts.fromState === 'DRAFT' ? 'D1' : 'D2',
			opts.decidedBy,
			opts.decision,
		],
	);
	return rows[0]!.id;
}

async function getStatus(id: number): Promise<string> {
	const { rows } = await pool.query<{ status: string }>(
		"SELECT status FROM roadmap_proposal.proposal WHERE id = $1",
		[id],
	);
	return rows[0]!.status;
}

async function getDiscussions(proposalId: number, prefix: string): Promise<string[]> {
	const { rows } = await pool.query<{ body: string }>(
		`SELECT body FROM roadmap_proposal.proposal_discussions
		  WHERE proposal_id = $1 AND context_prefix = $2
		  ORDER BY created_at`,
		[proposalId, prefix],
	);
	return rows.map(r => r.body);
}

async function ensureAgent(identity: string): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
		 VALUES ($1, 'llm', 'active')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	await ensureAgent(ADVANCER);
	await ensureAgent(REVIEWER);
	await ensureAgent(BLOCKER);
	await ensureAgent("system/gate-guard");
	await ensureAgent("system/gate-reconcile");
});

after(async () => {
	await pool.end();
});

describe("P3566 AC-5: fn_actor_is_independent", () => {
	it("returns true for distinct non-empty identities", async () => {
		const { rows } = await pool.query<{ result: boolean }>(
			`SELECT roadmap_proposal.fn_actor_is_independent($1, $2) AS result`,
			["alice", "bob"],
		);
		assert.equal(rows[0]!.result, true);
	});

	it("returns false for same identity", async () => {
		const { rows } = await pool.query<{ result: boolean }>(
			`SELECT roadmap_proposal.fn_actor_is_independent($1, $2) AS result`,
			["alice", "alice"],
		);
		assert.equal(rows[0]!.result, false);
	});

	it("returns false when reviewer is null", async () => {
		const { rows } = await pool.query<{ result: boolean }>(
			`SELECT roadmap_proposal.fn_actor_is_independent(NULL, 'bob') AS result`,
		);
		assert.equal(rows[0]!.result, false);
	});

	it("returns false when advancer is null", async () => {
		const { rows } = await pool.query<{ result: boolean }>(
			`SELECT roadmap_proposal.fn_actor_is_independent('alice', NULL) AS result`,
		);
		assert.equal(rows[0]!.result, false);
	});

	it("returns false when either is empty string", async () => {
		const { rows } = await pool.query<{ result: boolean }>(
			`SELECT roadmap_proposal.fn_actor_is_independent('', 'bob') AS result`,
		);
		assert.equal(rows[0]!.result, false);
	});
});

describe("P3566 AC-3: direct status update on non-terminal gate is rejected", () => {
	it("raises check_violation when no gate_decision_log row exists", async () => {
		const id = await insertTestProposal("DRAFT", "AC-3 direct update test");

		try {
			// Attempt direct status update without bypass — should be rejected by fn_guard_gate_advance.
			await pool.query(
				`UPDATE roadmap_proposal.proposal SET status = 'REVIEW' WHERE id = $1`,
				[id],
			);
			assert.fail("Expected check_violation, but query succeeded");
		} catch (err: any) {
			assert.match(
				err.message,
				/record_gate_decision|Non-terminal gate|check_violation/i,
				`Expected P3566 gate guard error, got: ${err.message}`,
			);
		} finally {
			await pool.query(
				`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
				[id],
			);
		}
	});
});

describe("P3566 AC-1: independent approver required for non-terminal advance", () => {
	it("blocks advance when only self-approve exists (reviewer == decided_by)", async () => {
		const id = await insertTestProposal("DRAFT", "AC-1 self-approve block test");

		// ADVANCER submits their own approve (self-approve).
		await insertReview({ proposalId: id, reviewer: ADVANCER, verdict: "approve" });

		// ADVANCER then submits gate_decision — fn_apply_gate_advance fires and checks independence.
		await insertGDL({
			proposalId: id,
			fromState: "DRAFT",
			toState: "REVIEW",
			decision: "advance",
			decidedBy: ADVANCER,
		});

		// Status should NOT have advanced (independence check failed).
		const status = await getStatus(id);
		assert.equal(status, "DRAFT", "Status should remain DRAFT when only self-approve exists");

		// Should have a flagged AC-1 discussion note.
		const notes = await getDiscussions(id, "gate-auth-violation:");
		assert.ok(notes.length > 0, "Expected a gate-auth-violation discussion note");
		assert.match(notes[0]!, /AC-1/, "Note should reference AC-1");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});

	it("allows advance when independent approve exists (reviewer != decided_by)", async () => {
		const id = await insertTestProposal("DRAFT", "AC-1 independent approve test");

		// REVIEWER submits an approve (independent of ADVANCER).
		await insertReview({ proposalId: id, reviewer: REVIEWER, verdict: "approve" });

		// ADVANCER submits gate_decision — independence check passes.
		await insertGDL({
			proposalId: id,
			fromState: "DRAFT",
			toState: "REVIEW",
			decision: "advance",
			decidedBy: ADVANCER,
		});

		const status = await getStatus(id);
		assert.equal(status, "REVIEW", "Status should advance to REVIEW with independent approve");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});
});

describe("P3566 AC-2: unresolved blocking review blocks advance", () => {
	it("blocks advance when blocking review is newer than independent approve", async () => {
		const id = await insertTestProposal("DRAFT", "AC-2 blocking newer than approve");

		// REVIEWER submits approve first.
		await insertReview({ proposalId: id, reviewer: REVIEWER, verdict: "approve" });

		// BLOCKER submits a blocking review AFTER the approve.
		// Small delay to ensure timestamps differ.
		await pool.query("SELECT pg_sleep(0.05)");
		await insertReview({ proposalId: id, reviewer: BLOCKER, verdict: "request_changes", isBlocking: true });

		// ADVANCER submits gate_decision — AC-2 check should block (blocking > approve).
		await insertGDL({
			proposalId: id,
			fromState: "DRAFT",
			toState: "REVIEW",
			decision: "advance",
			decidedBy: ADVANCER,
		});

		const status = await getStatus(id);
		assert.equal(status, "DRAFT", "Status should remain DRAFT when blocking review is newer");

		const notes = await getDiscussions(id, "gate-auth-violation:");
		assert.ok(notes.length > 0, "Expected a gate-auth-violation discussion note");
		assert.match(notes[notes.length - 1]!, /AC-2/, "Note should reference AC-2");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});

	it("allows advance when blocking review is superseded by a later independent approve", async () => {
		const id = await insertTestProposal("DRAFT", "AC-2 blocking superseded by later approve");

		// BLOCKER submits blocking review first.
		await insertReview({ proposalId: id, reviewer: BLOCKER, verdict: "request_changes", isBlocking: true });

		// REVIEWER submits approve AFTER the blocking review (supersedes it).
		await pool.query("SELECT pg_sleep(0.05)");
		await insertReview({ proposalId: id, reviewer: REVIEWER, verdict: "approve" });

		// ADVANCER submits gate_decision — approve is after blocking → should advance.
		await insertGDL({
			proposalId: id,
			fromState: "DRAFT",
			toState: "REVIEW",
			decision: "advance",
			decidedBy: ADVANCER,
		});

		const status = await getStatus(id);
		assert.equal(status, "REVIEW", "Status should advance when blocking is superseded by later approve");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});
});

describe("P3566 AC-4: late-blocking TOCTOU reconcile", () => {
	it("flags proposal when blocking review arrives after advance", async () => {
		const id = await insertTestProposal("DRAFT", "AC-4 late-blocking TOCTOU test");

		// Set up legitimate advance: independent approve → gate_decision → advances to REVIEW.
		await insertReview({ proposalId: id, reviewer: REVIEWER, verdict: "approve" });
		await insertGDL({
			proposalId: id,
			fromState: "DRAFT",
			toState: "REVIEW",
			decision: "advance",
			decidedBy: ADVANCER,
		});

		// Verify advance succeeded.
		const statusAfterAdvance = await getStatus(id);
		assert.equal(statusAfterAdvance, "REVIEW", "Should have advanced to REVIEW");

		// BLOCKER submits blocking review AFTER the advance (the P3535 incident pattern).
		await pool.query("SELECT pg_sleep(0.05)");
		await insertReview({ proposalId: id, reviewer: BLOCKER, verdict: "request_changes", isBlocking: true });

		// Should have a TOCTOU flag discussion.
		const notes = await getDiscussions(id, "gate-toctou-flag:");
		assert.ok(notes.length > 0, "Expected a gate-toctou-flag discussion note");
		assert.match(notes[0]!, /TOCTOU WARNING|AC-4/, "Note should reference TOCTOU/AC-4");

		// Status should NOT have been auto-reverted (auto-sendback is off by default).
		const statusAfterBlock = await getStatus(id);
		assert.equal(statusAfterBlock, "REVIEW", "Status should remain REVIEW (auto-sendback disabled)");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});

	it("does NOT flag when blocking review arrives before advance (normal flow)", async () => {
		const id = await insertTestProposal("DRAFT", "AC-4 blocking before advance — no flag");

		// Blocking review first.
		await insertReview({ proposalId: id, reviewer: BLOCKER, verdict: "request_changes", isBlocking: true });
		// No notes should be flagged (proposal still in DRAFT, not advanced yet).
		const notesBefore = await getDiscussions(id, "gate-toctou-flag:");
		assert.equal(notesBefore.length, 0, "No TOCTOU flag expected when proposal not yet advanced");

		await pool.query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
	});
});
