/**
 * P1391 — flag-gated verdict vocabulary in recordGateDecision (live DB).
 *
 * MERGE-SAFETY guarantees asserted here:
 *   • Flag OFF  ⇒ legacy vocab {advance,hold,reject,waive,escalate} accepted,
 *                 the new 'request_for_change' REJECTED at the vocab gate, and a
 *                 'reject' verdict does NOT drive maturity='obsolete' (the
 *                 destructive close is UNREACHABLE without the guard — AC-A6/V3).
 *   • Flag ON   ⇒ vocab restricted to {advance,request_for_change,reject};
 *                 legacy 'hold' REJECTED; an unauthorized 'reject' is DENIED
 *                 fail-closed and leaves maturity unchanged; an authorized
 *                 'request_for_change' drives maturity→new (this last positive
 *                 path needs migration 290's widened decision CHECK, so it is
 *                 conditional on the migration being applied).
 *
 * Run with AGENTHIVE_ALLOW_LIVE_DB=1 (the global pool refuses the live DB in
 * tests otherwise). No-permanent-write: a throwaway proposal + decider agent are
 * created and fully deleted in teardown.
 */
import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { query } from "../../../../postgres/pool.ts";
import { recordGateDecision } from "./pg-handlers.ts";

const SENTINEL = `p1391-vocab-${process.pid}`;
const DECIDER = `agent:${SENTINEL}:decider`;
let dbUp = true;
let pid: number | null = null;
let migration290Applied = false;

function textOf(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((c) => c.text ?? "").join("\n");
}

describe("P1391 recordGateDecision vocab gating (live)", () => {
	before(async () => {
		try {
			await query("SELECT 1");
		} catch {
			dbUp = false;
			return;
		}
		// decided_by FK → agent_registry; register the decider.
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier)
			 VALUES ($1, 'llm', 'restricted') ON CONFLICT (agent_identity) DO NOTHING`,
			[DECIDER],
		);
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, maturity, type, workflow_name, audit)
			 VALUES ($1, $2, 'REVIEW', 'mature', 'feature', 'Standard RFC', '[]'::jsonb)
			 RETURNING id`,
			[`P-${SENTINEL}`, `[${SENTINEL}] vocab fixture`],
		);
		pid = rows[0].id;

		// Detect migration-290 (widened decision CHECK accepts request_for_change).
		try {
			await query("BEGIN");
			await query(
				`INSERT INTO roadmap_proposal.gate_decision_log
				   (proposal_id, from_state, to_state, maturity, gate, decided_by, decision)
				 VALUES ($1,'REVIEW','REVIEW','mature','D2',$2,'request_for_change')`,
				[pid, DECIDER],
			);
			migration290Applied = true;
		} catch {
			migration290Applied = false;
		} finally {
			await query("ROLLBACK").catch(() => {});
		}
	});

	after(async () => {
		if (!dbUp || pid == null) return;
		await query(`DELETE FROM roadmap_proposal.gate_decision_log WHERE proposal_id = $1`, [
			pid,
		]).catch(() => {});
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [pid]).catch(() => {});
		await query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [
			DECIDER,
		]).catch(() => {});
	});

	test("FLAG OFF: legacy 'hold' accepted, 'request_for_change' rejected", async () => {
		if (!dbUp || pid == null) return;
		delete process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED; // default OFF

		const rfc = await recordGateDecision({
			id: String(pid),
			gate: "D2",
			decision: "request_for_change",
			decided_by: DECIDER,
		});
		assert.match(textOf(rfc), /Invalid decision 'request_for_change'/);

		const hold = await recordGateDecision({
			id: String(pid),
			gate: "D2",
			decision: "hold",
			decided_by: DECIDER,
		});
		// 'hold' is a legacy no-op verdict — accepted, logged, no maturity effect.
		assert.match(textOf(hold), /Gate decision recorded/);
	});

	test("FLAG OFF: 'reject' does NOT drive maturity→obsolete (unreachable)", async () => {
		if (!dbUp || pid == null) return;
		delete process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED;

		await query(`UPDATE roadmap_proposal.proposal SET maturity = 'mature' WHERE id = $1`, [pid]);
		const rej = await recordGateDecision({
			id: String(pid),
			gate: "D2",
			decision: "reject",
			decided_by: DECIDER,
		});
		assert.match(textOf(rej), /Gate decision recorded/);
		const { rows } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.notEqual(
			rows[0].maturity,
			"obsolete",
			"FLAG OFF: reject must NOT close the proposal (destructive path guarded)",
		);
	});

	test("FLAG ON: legacy 'hold' rejected (three-verdict vocab)", async () => {
		if (!dbUp || pid == null) return;
		process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED = "true";
		try {
			const hold = await recordGateDecision({
				id: String(pid),
				gate: "D2",
				decision: "hold",
				decided_by: DECIDER,
			});
			assert.match(textOf(hold), /Invalid decision 'hold'/);
		} finally {
			delete process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED;
		}
	});

	test("FLAG ON: unauthorized 'reject' DENIED fail-closed, maturity unchanged", async () => {
		if (!dbUp || pid == null) return;
		process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED = "true";
		try {
			await query(`UPDATE roadmap_proposal.proposal SET maturity = 'mature' WHERE id = $1`, [
				pid,
			]);
			const rej = await recordGateDecision({
				id: String(pid),
				gate: "D2",
				decision: "reject",
				decided_by: DECIDER, // registered agent but NO grant + NO token
			});
			assert.match(textOf(rej), /not authorized|AUTHORITY_REQUIRED/);
			const { rows } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.equal(
				rows[0].maturity,
				"mature",
				"unauthorized reject must not close the proposal",
			);
		} finally {
			delete process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED;
		}
	});

	test("FLAG ON: 'request_for_change' accepted → maturity new (needs migration 290)", async () => {
		if (!dbUp || pid == null) return;
		if (!migration290Applied) return; // skip cleanly until the migration is live
		process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED = "true";
		try {
			await query(`UPDATE roadmap_proposal.proposal SET maturity = 'mature' WHERE id = $1`, [
				pid,
			]);
			const rfc = await recordGateDecision({
				id: String(pid),
				gate: "D2",
				decision: "request_for_change",
				decided_by: DECIDER,
			});
			assert.match(textOf(rfc), /Gate decision recorded/);
			assert.match(textOf(rfc), /maturity set to 'new'/);
			const { rows } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.equal(rows[0].maturity, "new");
		} finally {
			delete process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED;
		}
	});
});
