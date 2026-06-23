/**
 * P4663/AC-13: Terminal builder/verifier/decider independence.
 *
 * Tests:
 *   1. RAISE when decider == proposal author (from audit JSON 'Created' Agent).
 *   2. RAISE when no non-system author can be resolved (fail-closed).
 *   3. PASS when decider differs from audit-resolved author.
 *   4. RAISE when decider matches fallback author (earliest discussion author).
 *
 * Author resolution order (P4663/AC-13):
 *   Primary:  audit JSONB array element with Activity='Created', Agent field
 *   Fallback: earliest proposal_discussions.author_identity NOT LIKE 'system%'
 *   Fail-closed: RAISE if neither resolves a non-system identity
 *
 * Requires: migration 319 applied, AGENTHIVE_ALLOW_LIVE_DB=1.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SKIP = !process.env.AGENTHIVE_ALLOW_LIVE_DB;

const AUTHOR = "test-p4663-termindep-author";
const DECIDER = "test-p4663-termindep-decider";

let pool: Pool;

async function ensureAgent(
	pool: Pool,
	identity: string,
	agentType = "llm",
	role = "developer",
): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, trust_tier)
		 VALUES ($1, $2, $3, 'restricted')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity, agentType, role],
	);
}

async function insertProposal(opts: {
	status: "MERGE" | "DEVELOP";
	auditAgent?: string | null; // null = empty audit array (no Created entry)
}): Promise<number> {
	const displayId = `P4663-termindep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	// null means empty array (no Created entry) — for fallback discussion test
	const audit =
		opts.auditAgent === null
			? "[]"
			: JSON.stringify([
					{
						TS: new Date(Date.now() - 10 * 86400000).toISOString(),
						Agent: opts.auditAgent ?? AUTHOR,
						Activity: "Created",
					},
				]);
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, status, maturity, type, project_id, audit)
		 VALUES ($1, $2, $3, 'mature', 'feature', 1, $4::jsonb)
		 RETURNING id`,
		[displayId, `TermIndep test ${displayId}`, opts.status, audit],
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
			 VALUES ($1, 1, 'P4663 terminal-independence test AC', 'pass', $2, 1)`,
			[proposalId, DECIDER],
		);
	} else {
		await pool.query(
			`UPDATE roadmap_proposal.proposal_acceptance_criteria
			    SET status = 'pass' WHERE proposal_id = $1 AND status IN ('pending','fail','blocked')`,
			[proposalId],
		);
	}
}

async function advanceMergeToComplete(
	proposalId: number,
	decidedBy: string,
): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_proposal.gate_decision_log
		     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
		 VALUES ($1, 'MERGE', 'COMPLETE', 'D4', $2, 'advance', 'P4663 terminal-independence test', 1)`,
		[proposalId, decidedBy],
	);
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	await ensureAgent(pool, AUTHOR);
	await ensureAgent(pool, DECIDER);
});

after(async () => {
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal_transition_ledger
		  WHERE proposal_id IN (
		      SELECT id FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-termindep-%'
		  )`,
	);
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-termindep-%'`,
	);
	await pool.end();
});

describe(
	"P4663/AC-13: terminal independence (decider != author)",
	{ skip: SKIP ? "AGENTHIVE_ALLOW_LIVE_DB not set" : false },
	() => {
		it("RAISE when decider equals audit-resolved proposal author", async () => {
			const proposalId = await insertProposal({
				status: "MERGE",
				auditAgent: AUTHOR,
			});
			await passAllACs(proposalId);

			// Decider IS the author — should raise terminal independence violation.
			await assert.rejects(
				() => advanceMergeToComplete(proposalId, AUTHOR),
				(err: Error) => {
					assert.ok(
						err.message.includes("Terminal independence violation") ||
							err.message.includes("independence"),
						`Expected terminal independence error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("RAISE when no non-system author can be resolved (fail-closed)", async () => {
			// No audit field, no non-system discussions — author resolution must fail closed.
			const displayId = `P4663-termindep-nosys-${Date.now()}`;
			const { rows } = await pool.query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
			     (display_id, title, status, maturity, type, project_id, audit)
			 VALUES ($1, 'Fail-closed test', 'MERGE', 'mature', 'feature', 1, '[]'::jsonb)
			 RETURNING id`,
				[displayId],
			);
			const proposalId = rows[0]!.id;
			await passAllACs(proposalId);

			await assert.rejects(
				() => advanceMergeToComplete(proposalId, DECIDER),
				(err: Error) => {
					assert.ok(
						err.message.includes("cannot resolve proposal author") ||
							err.message.includes("fail-closed") ||
							err.message.includes("fail closed"),
						`Expected fail-closed author error, got: ${err.message}`,
					);
					return true;
				},
			);

			await pool.query(
				`DELETE FROM roadmap_proposal.proposal WHERE display_id = $1`,
				[displayId],
			);
		});

		it("PASS when decider differs from audit-resolved author", async () => {
			const proposalId = await insertProposal({
				status: "MERGE",
				auditAgent: AUTHOR,
			});
			await passAllACs(proposalId);

			// DECIDER != AUTHOR — should pass terminal independence.
			await assert.doesNotReject(
				() => advanceMergeToComplete(proposalId, DECIDER),
				"Legitimate independent advance was rejected",
			);

			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(rows[0]!.status, "COMPLETE");
		});

		it("RAISE when decider matches fallback discussion author (no audit Created entry)", async () => {
			// Proposal with empty audit (no 'Created' entry) → fallback to discussions
			const proposalId = await insertProposal({
				status: "MERGE",
				auditAgent: null,
			});
			await pool.query(
				`INSERT INTO roadmap_proposal.proposal_discussions
			     (proposal_id, author_identity, context_prefix, body)
			 VALUES ($1, $2, 'general:', 'Fallback author test discussion')`,
				[proposalId, DECIDER],
			);
			await passAllACs(proposalId);

			// DECIDER == fallback author — should RAISE independence violation.
			await assert.rejects(
				() => advanceMergeToComplete(proposalId, DECIDER),
				(err: Error) => {
					assert.ok(
						err.message.includes("independence") ||
							err.message.includes("author"),
						`Expected independence/author error, got: ${err.message}`,
					);
					return true;
				},
			);
		});
	},
);
