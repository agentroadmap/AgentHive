/**
 * Integration tests for migration 059 — P611 gate-decision auto-advance trigger.
 *
 * Tests the AFTER INSERT trigger trg_apply_gate_advance on gate_decision_log:
 *   (a) advance path: decision='advance' flips proposal.status and logs a discussion
 *   (b) idempotent no-op: inserting the same advance twice doesn't break anything
 *   (c) drift warning: from_state mismatch logs a WARNING discussion, no status flip
 *   (d) non-advance decision: hold/reject/etc. leave proposal.status unchanged
 *
 * Uses a real Postgres connection — no mocks.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ??
	"postgresql://admin:YMA3peHGLi6shUTr@127.0.0.1:5432/agenthive";

let pool: Pool;

// Insert a minimal proposal row and return its id.
async function insertTestProposal(
	pool: Pool,
	status: string,
	title: string,
): Promise<number> {
	const displayId = `P611-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, status, maturity, type, project_id, audit)
		 VALUES ($1, $2, $3, 'active', 'feature', 1, '{"created_by":"test","created_at":"2026-01-01"}'::jsonb)
		 RETURNING id`,
		[displayId, title, status],
	);
	return rows[0]!.id;
}

// Insert a gate_decision_log row; returns inserted id.
async function insertGDL(
	pool: Pool,
	opts: {
		proposalId: number;
		decision: string;
		fromState: string;
		toState: string;
	},
): Promise<number> {
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.gate_decision_log
		     (proposal_id, decision, from_state, to_state, decided_by, rationale)
		 VALUES ($1, $2, $3, $4, 'test-runner-p611', 'P611 integration test')
		 RETURNING id`,
		[opts.proposalId, opts.decision, opts.fromState, opts.toState],
	);
	return rows[0]!.id;
}

// Fetch current status of a proposal.
async function getStatus(pool: Pool, id: number): Promise<string> {
	const { rows } = await pool.query<{ status: string }>(
		"SELECT status FROM roadmap_proposal.proposal WHERE id = $1",
		[id],
	);
	return rows[0]!.status;
}

// Fetch discussion rows for a proposal authored by a system identity.
async function getSystemDiscussions(
	pool: Pool,
	proposalId: number,
	authorIdentity: string,
): Promise<Array<{ body: string; context_prefix: string }>> {
	const { rows } = await pool.query<{ body: string; context_prefix: string }>(
		`SELECT body, context_prefix
		   FROM roadmap_proposal.proposal_discussions
		  WHERE proposal_id = $1
		    AND author_identity = $2
		  ORDER BY created_at`,
		[proposalId, authorIdentity],
	);
	return rows;
}

// Cleanup: delete test rows by proposal id.
async function cleanup(pool: Pool, proposalId: number): Promise<void> {
	await pool.query(
		"DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1",
		[proposalId],
	);
	await pool.query(
		"DELETE FROM roadmap_proposal.gate_decision_log WHERE proposal_id = $1",
		[proposalId],
	);
	await pool.query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [
		proposalId,
	]);
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	// Verify connectivity.
	await pool.query("SELECT 1");
	// Register a test-only decided_by identity for gate_decision_log FK.
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry
		     (agent_identity, agent_type, status, trust_tier, project_id)
		 VALUES ('test-runner-p611', 'tool', 'active', 'restricted', 1)
		 ON CONFLICT (agent_identity) DO NOTHING`,
	);
});

after(async () => {
	// Prune any remaining GDL rows first (FK: gate_decision_log.decided_by → agent_registry).
	await pool.query(
		`DELETE FROM roadmap_proposal.gate_decision_log WHERE decided_by = 'test-runner-p611'`,
	);
	await pool.query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = 'test-runner-p611'`,
	);
	await pool.end();
});

describe("Migration 059 — trg_apply_gate_advance", () => {
	// ─── (a) Advance path ─────────────────────────────────────────────────────

	describe("(a) advance path: flips status and logs discussion", () => {
		let proposalId: number;

		before(async () => {
			proposalId = await insertTestProposal(
				pool,
				"DEVELOP",
				"P611-test-advance",
			);
		});

		after(async () => {
			await cleanup(pool, proposalId);
		});

		it("should flip proposal.status from DEVELOP to MERGE", async () => {
			await insertGDL(pool, {
				proposalId,
				decision: "advance",
				fromState: "DEVELOP",
				toState: "MERGE",
			});
			const status = await getStatus(pool, proposalId);
			assert.equal(status, "MERGE", "Status should have been flipped to MERGE");
		});

		it("should log an auto-advance discussion entry", async () => {
			const discussions = await getSystemDiscussions(
				pool,
				proposalId,
				"system/auto-advance",
			);
			assert.ok(
				discussions.length > 0,
				"Should have at least one auto-advance discussion",
			);
			assert.equal(
				discussions[0]!.context_prefix,
				"gate-decision:",
				"Discussion context_prefix should be 'gate-decision:'",
			);
			assert.ok(
				discussions[0]!.body.includes("Auto-advanced"),
				"Discussion body should mention auto-advance",
			);
			assert.ok(
				discussions[0]!.body.includes("fn_apply_gate_advance"),
				"Discussion body should name the trigger function",
			);
		});
	});

	// ─── (b) Idempotent no-op ─────────────────────────────────────────────────

	describe("(b) idempotent no-op: second advance on same target is a no-op", () => {
		let proposalId: number;

		before(async () => {
			proposalId = await insertTestProposal(
				pool,
				"DEVELOP",
				"P611-test-idempotent",
			);
		});

		after(async () => {
			await cleanup(pool, proposalId);
		});

		it("should not error when status is already at to_state", async () => {
			// First advance flips DEVELOP → MERGE
			await insertGDL(pool, {
				proposalId,
				decision: "advance",
				fromState: "DEVELOP",
				toState: "MERGE",
			});
			assert.equal(await getStatus(pool, proposalId), "MERGE");

			// Second GDL row with same to_state — trigger should be a silent no-op
			await assert.doesNotReject(async () => {
				await insertGDL(pool, {
					proposalId,
					decision: "advance",
					fromState: "DEVELOP", // stale from_state; status is already 'MERGE'
					toState: "MERGE",
				});
			}, "Second advance insert should not throw");

			assert.equal(
				await getStatus(pool, proposalId),
				"MERGE",
				"Status should still be MERGE",
			);
		});
	});

	// ─── (c) Drift warning ────────────────────────────────────────────────────

	describe("(c) drift warning: from_state mismatch logs warning, no flip", () => {
		let proposalId: number;

		before(async () => {
			proposalId = await insertTestProposal(
				pool,
				"REVIEW",
				"P611-test-drift",
			);
		});

		after(async () => {
			await cleanup(pool, proposalId);
		});

		it("should log a WARNING discussion when from_state does not match status", async () => {
			await insertGDL(pool, {
				proposalId,
				decision: "advance",
				fromState: "DEVELOP", // proposal.status is 'REVIEW', not 'DEVELOP'
				toState: "MERGE",
			});

			// Status should be unchanged
			assert.equal(
				await getStatus(pool, proposalId),
				"REVIEW",
				"Status should remain REVIEW when from_state mismatches",
			);

			// Should have a WARNING discussion
			const discussions = await getSystemDiscussions(
				pool,
				proposalId,
				"system/auto-advance",
			);
			assert.ok(discussions.length > 0, "Should have a drift warning discussion");
			assert.ok(
				discussions[0]!.body.includes("WARNING"),
				"Discussion body should contain WARNING",
			);
			assert.ok(
				discussions[0]!.body.includes("No action"),
				"Discussion body should say No action",
			);
		});
	});

	// ─── (d) Non-advance decision: no-op ─────────────────────────────────────

	describe("(d) non-advance decisions: trigger does nothing", () => {
		let proposalId: number;

		before(async () => {
			proposalId = await insertTestProposal(
				pool,
				"DEVELOP",
				"P611-test-noadvance",
			);
		});

		after(async () => {
			await cleanup(pool, proposalId);
		});

		it("should not flip status for decision='hold'", async () => {
			await insertGDL(pool, {
				proposalId,
				decision: "hold",
				fromState: "DEVELOP",
				toState: "MERGE",
			});
			assert.equal(
				await getStatus(pool, proposalId),
				"DEVELOP",
				"Status should remain DEVELOP for a hold decision",
			);
		});

		it("should not flip status for decision='reject'", async () => {
			await insertGDL(pool, {
				proposalId,
				decision: "reject",
				fromState: "DEVELOP",
				toState: "MERGE",
			});
			assert.equal(
				await getStatus(pool, proposalId),
				"DEVELOP",
				"Status should remain DEVELOP for a reject decision",
			);
		});

		it("should not create any auto-advance discussion entries", async () => {
			const discussions = await getSystemDiscussions(
				pool,
				proposalId,
				"system/auto-advance",
			);
			assert.equal(
				discussions.length,
				0,
				"Non-advance decisions should not create system/auto-advance discussions",
			);
		});
	});
});
