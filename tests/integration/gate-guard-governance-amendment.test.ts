/**
 * P4663/AC-14: Governance-amendment gate checks.
 *
 * Tests:
 *   1. DRAFT→DELIBERATION is a guarded edge (requires gate_decision_log).
 *   2. DELIBERATION→REVIEW is refused when < 48h elapsed (P_gov48h).
 *   3. DELIBERATION→REVIEW passes when >= 48h elapsed.
 *   4. MERGE→COMPLETE on governance-amendment requires human-role decider (P_govHuman).
 *   5. MERGE→COMPLETE passes when human-role decider provided.
 *   6. governance-amendment terminal gate also refuses < 48h from creation.
 *
 * Human-role set: agent_type = 'human' in agent_registry (AC-14).
 *
 * Requires: migration 319 applied, AGENTHIVE_ALLOW_LIVE_DB=1.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SKIP = !process.env.AGENTHIVE_ALLOW_LIVE_DB;

const LLM_DECIDER = "test-p4663-gov-llm-decider";
const HUMAN_DECIDER = "test-p4663-gov-human-decider";
const AUTHOR = "test-p4663-gov-author";

let pool: Pool;

async function ensureAgent(
	pool: Pool,
	identity: string,
	agentType: string,
	role = "developer",
): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, trust_tier)
		 VALUES ($1, $2, $3, 'restricted')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity, agentType, role],
	);
}

async function insertGovProposal(opts: {
	status: string;
	createdAt?: Date; // for testing 48h boundary
	stateChangedAt?: Date; // for testing DELIBERATION 48h
}): Promise<number> {
	const displayId = `P4663-gov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const audit = JSON.stringify([
		{
			TS: (opts.createdAt ?? new Date()).toISOString(),
			Agent: AUTHOR,
			Activity: "Created",
		},
	]);
	const created = opts.createdAt ?? new Date(Date.now() - 72 * 3600000); // 3 days ago by default
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, summary, status, maturity, type, project_id, audit, created_at, state_changed_at)
		 VALUES ($1, $2, $3, $4, 'mature', 'governance-amendment', 1, $5::jsonb, $6, $7)
		 RETURNING id`,
		[
			displayId,
			`Gov test ${displayId}`,
			`Governance amendment test proposal — ${displayId}`,
			opts.status,
			audit,
			created,
			opts.stateChangedAt ?? created,
		],
	);
	return rows[0]!.id;
}

async function passAllACs(proposalId: number): Promise<void> {
	const { rows } = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
		[proposalId],
	);
	if (Number(rows[0]!.count) === 0) {
		await pool.query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			     (proposal_id, item_number, criterion_text, status, verified_by, project_id)
			 VALUES ($1, 1, 'Gov amendment AC', 'pass', $2, 1)`,
			[proposalId, HUMAN_DECIDER],
		);
	} else {
		await pool.query(
			`UPDATE roadmap_proposal.proposal_acceptance_criteria
			    SET status = 'pass' WHERE proposal_id = $1 AND status IN ('pending','fail','blocked')`,
			[proposalId],
		);
	}
}

async function insertGDL(opts: {
	proposalId: number;
	from: string;
	to: string;
	gate: string;
	decidedBy: string;
}): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_proposal.gate_decision_log
		     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
		 VALUES ($1, $2, $3, $4, $5, 'advance', 'P4663 governance test', 1)`,
		[opts.proposalId, opts.from, opts.to, opts.gate, opts.decidedBy],
	);
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	await ensureAgent(pool, AUTHOR, "llm");
	await ensureAgent(pool, LLM_DECIDER, "llm");
	await ensureAgent(pool, HUMAN_DECIDER, "human", "reviewer");
});

after(async () => {
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal_transition_ledger
		  WHERE proposal_id IN (
		      SELECT id FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-gov-%'
		  )`,
	);
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-gov-%'`,
	);
	await pool.end();
});

describe(
	"P4663/AC-14: governance-amendment gate",
	{ skip: SKIP ? "AGENTHIVE_ALLOW_LIVE_DB not set" : false },
	() => {
		it("DRAFT→DELIBERATION is a guarded edge (direct UPDATE refused)", async () => {
			const proposalId = await insertGovProposal({ status: "DRAFT" });

			await assert.rejects(
				() =>
					pool.query(
						`UPDATE roadmap_proposal.proposal SET status='DELIBERATION' WHERE id=$1`,
						[proposalId],
					),
				(err: Error) => {
					// Should be check_violation — gate guard fired
					assert.ok(
						err.message.includes("gate_decision_log") ||
							err.message.includes("requires"),
						`Expected gate guard error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("DELIBERATION→REVIEW refused when < 48h elapsed (P_gov48h)", async () => {
			// state_changed_at = 2 hours ago (well within 48h window)
			const recentStateChange = new Date(Date.now() - 2 * 3600000);
			const proposalId = await insertGovProposal({
				status: "DELIBERATION",
				stateChangedAt: recentStateChange,
			});

			// fn_apply_gate_advance (AFTER INSERT on GDL) calls UPDATE on proposal, which fires
			// fn_guard_gate_advance (BEFORE UPDATE). The guard RAISEs, which propagates back through
			// fn_apply_gate_advance and causes the GDL INSERT itself to throw. Whole txn rolls back.
			await assert.rejects(
				() =>
					pool.query(
						`INSERT INTO roadmap_proposal.gate_decision_log
				     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
				 VALUES ($1, 'DELIBERATION', 'REVIEW', 'G2', $2, 'advance', 'P4663 gov 48h test', 1)`,
						[proposalId, LLM_DECIDER],
					),
				(err: Error) => {
					assert.ok(
						err.message.includes("48") || err.message.includes("deliberation"),
						`Expected 48h deliberation error, got: ${err.message}`,
					);
					return true;
				},
			);

			// Confirm status still DELIBERATION (txn was rolled back)
			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(
				rows[0]!.status,
				"DELIBERATION",
				"DELIBERATION→REVIEW should have been blocked by 48h check",
			);
		});

		it("DELIBERATION→REVIEW passes when >= 48h elapsed", async () => {
			// state_changed_at = 3 days ago (well past 48h)
			const oldStateChange = new Date(Date.now() - 3 * 86400000);
			const proposalId = await insertGovProposal({
				status: "DELIBERATION",
				stateChangedAt: oldStateChange,
			});

			// Insert independent review first (required by fn_apply_gate_advance non-terminal AC-1)
			await pool.query(
				`INSERT INTO roadmap_proposal.proposal_reviews
			     (proposal_id, reviewer_identity, verdict, is_blocking, notes)
			 VALUES ($1, $2, 'approve', false, 'P4663 gov deliberation passed test')`,
				[proposalId, HUMAN_DECIDER],
			);

			await assert.doesNotReject(
				() =>
					pool.query(
						`INSERT INTO roadmap_proposal.gate_decision_log
				     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
				 VALUES ($1, 'DELIBERATION', 'REVIEW', 'G2', $2, 'advance', 'P4663 gov 48h passed', 1)`,
						[proposalId, LLM_DECIDER],
					),
				"DELIBERATION→REVIEW with >= 48h elapsed should pass",
			);

			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(
				rows[0]!.status,
				"REVIEW",
				"Proposal should have advanced to REVIEW after 48h elapsed",
			);
		});

		it("MERGE→COMPLETE refuses non-human decider for governance-amendment", async () => {
			const proposalId = await insertGovProposal({ status: "MERGE" });
			await passAllACs(proposalId);

			// LLM_DECIDER (agent_type=llm, not human) should be refused
			await assert.rejects(
				() =>
					insertGDL({
						proposalId,
						from: "MERGE",
						to: "COMPLETE",
						gate: "D4",
						decidedBy: LLM_DECIDER,
					}),
				(err: Error) => {
					assert.ok(
						err.message.includes("human") || err.message.includes("human-role"),
						`Expected human-role error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("MERGE→COMPLETE passes with human-role decider for governance-amendment", async () => {
			// Created > 48h ago (default is 3 days)
			const proposalId = await insertGovProposal({ status: "MERGE" });
			await passAllACs(proposalId);

			// HUMAN_DECIDER != AUTHOR, agent_type=human — should pass all checks
			await assert.doesNotReject(
				() =>
					insertGDL({
						proposalId,
						from: "MERGE",
						to: "COMPLETE",
						gate: "D4",
						decidedBy: HUMAN_DECIDER,
					}),
				"governance-amendment MERGE→COMPLETE with human decider should pass",
			);

			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(rows[0]!.status, "COMPLETE");
		});

		it("terminal gate refuses governance-amendment created < 48h ago", async () => {
			// Created only 2 hours ago
			const recentlyCreated = new Date(Date.now() - 2 * 3600000);
			const proposalId = await insertGovProposal({
				status: "MERGE",
				createdAt: recentlyCreated,
				stateChangedAt: recentlyCreated,
			});
			await passAllACs(proposalId);

			await assert.rejects(
				() =>
					insertGDL({
						proposalId,
						from: "MERGE",
						to: "COMPLETE",
						gate: "D4",
						decidedBy: HUMAN_DECIDER,
					}),
				(err: Error) => {
					assert.ok(
						err.message.includes("48") || err.message.includes("deliberation"),
						`Expected 48h deliberation error, got: ${err.message}`,
					);
					return true;
				},
			);
		});
	},
);
