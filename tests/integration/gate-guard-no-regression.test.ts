/**
 * P4663/AC-11: Canonical fn_guard_gate_advance preserves all RAISE conditions
 * from prior migration writers {189, 254, 270, 289, 291, 299}.
 *
 * This test is structural: it inspects pg_get_functiondef output and checks
 * that every governance invariant is present in the canonical function.
 *
 * AC-8/AC-9: P3929 (non-terminal bypass removal) and P3566 (gate-decision-log
 * enforcement) regression checks — behavioral tests.
 *
 * Requires: migration 319 applied, AGENTHIVE_ALLOW_LIVE_DB=1.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SKIP = !process.env.AGENTHIVE_ALLOW_LIVE_DB;

const DECIDER = "test-p4663-noreg-decider";
const REVIEWER = "test-p4663-noreg-reviewer";
const AUTHOR = "test-p4663-noreg-author";

let pool: Pool;

async function ensureAgent(
	pool: Pool,
	identity: string,
	agentType = "llm",
): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, trust_tier)
		 VALUES ($1, $2, 'developer', 'restricted')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity, agentType],
	);
}

async function mkProposal(status: string, type = "feature"): Promise<number> {
	const displayId = `P4663-noreg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const audit = JSON.stringify([
		{
			TS: new Date(Date.now() - 10 * 86400000).toISOString(),
			Agent: AUTHOR,
			Activity: "Created",
		},
	]);
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, status, maturity, type, project_id, audit)
		 VALUES ($1, $2, $3, 'mature', $4, 1, $5::jsonb)
		 RETURNING id`,
		[displayId, `NoReg test ${displayId}`, status, type, audit],
	);
	return rows[0]!.id;
}

async function passAC(proposalId: number): Promise<void> {
	const { rows } = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
		[proposalId],
	);
	if (Number(rows[0]!.count) === 0) {
		await pool.query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			     (proposal_id, item_number, criterion_text, status, verified_by, project_id)
			 VALUES ($1, 1, 'verified', 'pass', $2, 1)`,
			[proposalId, REVIEWER],
		);
	}
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	await ensureAgent(pool, AUTHOR);
	await ensureAgent(pool, DECIDER);
	await ensureAgent(pool, REVIEWER);
});

after(async () => {
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal_transition_ledger
		  WHERE proposal_id IN (
		      SELECT id FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-noreg-%'
		  )`,
	);
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-noreg-%'`,
	);
	await pool.end();
});

describe(
	"P4663/AC-11: structural raise-condition map (canonical fn_guard_gate_advance)",
	{ skip: SKIP ? "AGENTHIVE_ALLOW_LIVE_DB not set" : false },
	() => {
		it("function source has no live code referencing gate_bypass (P_noBypass)", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			// Strip single-line SQL comments before checking — comment mentions are docs, not code.
			const codeOnly = rows[0]!.def.replace(/--[^\n]*/g, "");
			assert.ok(
				!codeOnly.includes("gate_bypass"),
				"fn_guard_gate_advance has live code referencing gate_bypass — P_noBypass broken",
			);
		});

		it("function source contains P_termAC: zero-AC guard (v_ac_count = 0)", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("v_ac_count") || def.includes("ac_count"),
				"fn_guard_gate_advance missing AC-count variable — P_termAC check absent",
			);
			assert.ok(
				def.includes("zero acceptance criteria") ||
					def.includes("v_ac_count = 0"),
				"fn_guard_gate_advance missing zero-AC RAISE — P_termAC check absent",
			);
		});

		it("function source contains P_termIndep: terminal independence check", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("Terminal independence violation") ||
					def.includes("independence"),
				"fn_guard_gate_advance missing terminal independence RAISE — P_termIndep absent",
			);
		});

		it("function source contains P_log: gate_decision_log mandatory check", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("gate_decision_log"),
				"fn_guard_gate_advance missing gate_decision_log reference — P_log absent",
			);
		});

		it("function source contains P_govHuman: human-role decider check", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("agent_type") && def.includes("human"),
				"fn_guard_gate_advance missing agent_type='human' check — P_govHuman absent",
			);
		});

		it("function source contains P_gov48h: 48h deliberation guard", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("48 hours") ||
					def.includes("48h") ||
					def.includes("INTERVAL '48"),
				"fn_guard_gate_advance missing 48h interval check — P_gov48h absent",
			);
		});

		it("function source contains P_govEdges: DELIBERATION edges in gate key list", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			assert.ok(
				def.includes("DELIBERATION"),
				"fn_guard_gate_advance missing DELIBERATION in gate key list — P_govEdges absent",
			);
		});
	},
);

describe(
	"P4663/AC-8/AC-9: P3929+P3566 regression tests",
	{ skip: SKIP ? "AGENTHIVE_ALLOW_LIVE_DB not set" : false },
	() => {
		it("AC-8: direct DRAFT→REVIEW UPDATE is refused (P3566 regression)", async () => {
			const proposalId = await mkProposal("DRAFT");
			await assert.rejects(
				() =>
					pool.query(
						`UPDATE roadmap_proposal.proposal SET status='REVIEW' WHERE id=$1`,
						[proposalId],
					),
				(err: Error) => {
					assert.ok(
						err.message.includes("gate_decision_log") ||
							err.message.includes("requires"),
						`Expected gate guard error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("AC-8: direct REVIEW→DEVELOP UPDATE is refused (P3566 regression)", async () => {
			const proposalId = await mkProposal("REVIEW");
			await assert.rejects(
				() =>
					pool.query(
						`UPDATE roadmap_proposal.proposal SET status='DEVELOP' WHERE id=$1`,
						[proposalId],
					),
				(err: Error) => {
					assert.ok(
						err.message.includes("gate_decision_log") ||
							err.message.includes("requires"),
						`Expected gate guard error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("AC-9: non-terminal gate cannot be bypassed via SET app.gate_bypass (P3929 regression)", async () => {
			const proposalId = await mkProposal("DRAFT");
			// Even with gate_bypass set, non-terminal gate should refuse.
			// Use a dedicated client + BEGIN/COMMIT so SET LOCAL is in the same txn as UPDATE.
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SET LOCAL app.gate_bypass = 'true'");
				await assert.rejects(
					() =>
						client.query(
							`UPDATE roadmap_proposal.proposal SET status='REVIEW' WHERE id=$1`,
							[proposalId],
						),
					(err: Error) => {
						// P4663 removed bypass entirely — gate guard must fire regardless
						assert.ok(
							err.message.includes("gate_decision_log") ||
								err.message.includes("requires") ||
								err.message.includes("gate"),
							`Expected gate guard rejection even with bypass, got: ${err.message}`,
						);
						return true;
					},
				);
			} finally {
				await client.query("ROLLBACK").catch(() => {});
				client.release();
			}
		});

		it("AC-9: terminal gate MERGE→COMPLETE works via gate_decision_log (normal path)", async () => {
			const proposalId = await mkProposal("MERGE");
			await passAC(proposalId);

			// DECIDER != AUTHOR — should succeed
			await assert.doesNotReject(
				() =>
					pool.query(
						`INSERT INTO roadmap_proposal.gate_decision_log
				     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
				 VALUES ($1, 'MERGE', 'COMPLETE', 'D4', $2, 'advance', 'P4663 regression test', 1)`,
						[proposalId, DECIDER],
					),
				"Legitimate MERGE→COMPLETE via GDL should succeed",
			);

			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(rows[0]!.status, "COMPLETE");
		});

		it("AC-11: MERGE→COMPLETE with zero ACs is refused (P_termAC)", async () => {
			const proposalId = await mkProposal("MERGE");
			// Do NOT add any ACs — zero should trigger P_termAC

			await assert.rejects(
				() =>
					pool.query(
						`INSERT INTO roadmap_proposal.gate_decision_log
				     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
				 VALUES ($1, 'MERGE', 'COMPLETE', 'D4', $2, 'advance', 'P4663 zero-AC test', 1)`,
						[proposalId, DECIDER],
					),
				(err: Error) => {
					assert.ok(
						err.message.includes("zero acceptance criteria") ||
							err.message.includes("acceptance criteria") ||
							err.message.includes("ac_count"),
						`Expected zero-AC error, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("AC-11: MERGE→COMPLETE with pending AC is refused (P_termAC)", async () => {
			const proposalId = await mkProposal("MERGE");
			// Add a pending AC (not passed)
			await pool.query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			     (proposal_id, item_number, criterion_text, status, project_id)
			 VALUES ($1, 1, 'Unverified requirement', 'pending', 1)`,
				[proposalId],
			);

			await assert.rejects(
				() =>
					pool.query(
						`INSERT INTO roadmap_proposal.gate_decision_log
				     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
				 VALUES ($1, 'MERGE', 'COMPLETE', 'D4', $2, 'advance', 'P4663 pending-AC test', 1)`,
						[proposalId, DECIDER],
					),
				(err: Error) => {
					assert.ok(
						err.message.includes("pending") ||
							err.message.includes("unwaived") ||
							err.message.includes("acceptance criteria"),
						`Expected unwaived-AC error, got: ${err.message}`,
					);
					return true;
				},
			);
		});
	},
);
