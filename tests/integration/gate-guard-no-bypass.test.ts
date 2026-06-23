/**
 * P4663/AC-12: No app.gate_bypass in canonical fn_guard_gate_advance.
 *
 * Tests:
 *   1. pg_get_functiondef for fn_guard_gate_advance contains ZERO references to
 *      'gate_bypass' (structural proof).
 *
 *   2. Behavioral: a legitimate MERGE→COMPLETE advance via gate_decision_log succeeds
 *      with app.gate_bypass unset — proving the legitimate apply path never depended
 *      on the bypass.
 *
 * Requires: migration 319 applied, AGENTHIVE_ALLOW_LIVE_DB=1.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SKIP = !process.env.AGENTHIVE_ALLOW_LIVE_DB;

const DECIDER = "test-p4663-nobypass-decider";
const REVIEWER = "test-p4663-nobypass-reviewer";

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
	status: string;
	type?: string;
	auditAgent?: string;
}): Promise<number> {
	const displayId = `P4663-nobp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const audit = JSON.stringify([
		{
			TS: new Date(Date.now() - 10 * 86400000).toISOString(),
			Agent: opts.auditAgent ?? REVIEWER,
			Activity: "Created",
		},
	]);
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		     (display_id, title, status, maturity, type, project_id, audit)
		 VALUES ($1, $2, $3, 'new', $4, 1, $5::jsonb)
		 RETURNING id`,
		[
			displayId,
			`NoBypass test ${displayId}`,
			opts.status,
			opts.type ?? "feature",
			audit,
		],
	);
	return rows[0]!.id;
}

async function passAllACs(proposalId: number): Promise<void> {
	// Ensure at least one AC exists and is passed so MERGE→COMPLETE doesn't block.
	const { rows } = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
		[proposalId],
	);
	if (Number(rows[0]!.count) === 0) {
		await pool.query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			     (proposal_id, item_number, criterion_text, status, verified_by, project_id)
			 VALUES ($1, 1, 'Functional delivery verified', 'pass', $2, 1)`,
			[proposalId, REVIEWER],
		);
	} else {
		await pool.query(
			`UPDATE roadmap_proposal.proposal_acceptance_criteria
			    SET status = 'pass', verified_by = $2
			  WHERE proposal_id = $1 AND status IN ('pending','fail','blocked')`,
			[proposalId, REVIEWER],
		);
	}
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL });
	await ensureAgent(pool, DECIDER);
	await ensureAgent(pool, REVIEWER);
});

after(async () => {
	// Delete transition_ledger rows first (FK references proposal.id)
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal_transition_ledger
		  WHERE proposal_id IN (
		      SELECT id FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-nobp-%'
		  )`,
	);
	await pool.query(
		`DELETE FROM roadmap_proposal.proposal WHERE display_id LIKE 'P4663-nobp-%'`,
	);
	await pool.end();
});

describe(
	"P4663/AC-12: no app.gate_bypass in fn_guard_gate_advance",
	{ skip: SKIP ? "AGENTHIVE_ALLOW_LIVE_DB not set" : false },
	() => {
		it("structural: pg_get_functiondef contains no live code reference to 'gate_bypass'", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			// Strip single-line comments (-- ...) before checking for code references.
			// Mentions in comments are informational; only live code calls break P_noBypass.
			const codeOnly = def.replace(/--[^\n]*/g, "");
			assert.ok(
				!codeOnly.includes("gate_bypass"),
				`fn_guard_gate_advance has live code referencing 'gate_bypass' — P_noBypass invariant violated.\n` +
					`Found in: ${codeOnly.substring(codeOnly.indexOf("gate_bypass") - 100, codeOnly.indexOf("gate_bypass") + 200)}`,
			);
		});

		it("behavioral: MERGE→COMPLETE succeeds via gate_decision_log with gate_bypass unset", async () => {
			// Setup: proposal in MERGE with a passed AC (reviewer = author is different from decider)
			const proposalId = await insertProposal({
				status: "MERGE",
				auditAgent: REVIEWER,
			});
			await passAllACs(proposalId);

			// Unset gate_bypass (ensure clean session)
			await pool.query(`SET app.gate_bypass = ''`);

			// Insert gate_decision_log advance row (decided_by=DECIDER != REVIEWER=author)
			await pool.query(
				`INSERT INTO roadmap_proposal.gate_decision_log
			     (proposal_id, from_state, to_state, gate, decided_by, decision, rationale, project_id)
			 VALUES ($1, 'MERGE', 'COMPLETE', 'D4', $2, 'advance', 'P4663 no-bypass test', 1)`,
				[proposalId, DECIDER],
			);

			// fn_apply_gate_advance fires and should advance status to COMPLETE without bypass
			const { rows } = await pool.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			assert.equal(
				rows[0]!.status,
				"COMPLETE",
				"Proposal did not advance to COMPLETE — legitimate apply path broken",
			);
		});

		it("structural: fn_apply_gate_advance has no live 'SET LOCAL app.gate_bypass' code", async () => {
			const { rows } = await pool.query<{ def: string }>(
				`SELECT pg_get_functiondef('roadmap_proposal.fn_apply_gate_advance'::regproc) AS def`,
			);
			const def = rows[0]!.def;
			// P3929/mig299 removed SET LOCAL app.gate_bypass from fn_apply_gate_advance.
			// Strip single-line comments before checking — comment mentions are informational.
			const codeOnly = def.replace(/--[^\n]*/g, "");
			assert.ok(
				!codeOnly.includes("SET LOCAL app.gate_bypass"),
				"fn_apply_gate_advance still has live 'SET LOCAL app.gate_bypass' code — P3929/P906 regression",
			);
		});
	},
);
