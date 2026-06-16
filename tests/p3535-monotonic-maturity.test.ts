/**
 * P3535 — Monotonic maturity lifecycle: decouple maturity from lease occupancy.
 *
 * AC-1: Claiming a proposal only sets new→active; active/mature are unchanged by claim.
 * AC-2: Active is sticky — release, lease expiry, or re-claim never reverts to new.
 * AC-3: active→mature via work_delivered/gate_review_complete/authored_complete preserved.
 * AC-5: mature is sticky across gate claims (gate roles don't flip to active).
 * AC-6: mature→new ONLY via send-back bucket (gate_hold/gate_reject/work_failed/
 *       manual_release/reassigned/force_reclaimed). Non-send-back reasons preserve mature.
 * AC-7: exclusive claim unchanged (P1391 owns it — lease_is_live, no_overlap_live).
 * AC-9: migration reconcile restored COMPLETE/active rows to mature.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/postgres/pool.ts";

const AGENT = "p3535-test-agent";
const SEND_BACK = ["gate_hold", "gate_reject", "work_failed", "manual_release", "reassigned", "force_reclaimed"] as const;
const NON_SEND_BACK = ["lease_expired", "released_unfinished", "operator_cancelled", "operator_terminated", "gate_dispatch_blocked", "gate_spawn_failed", "gate_transitioned"] as const;

async function createProposal(maturity: string): Promise<number> {
	const r = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, audit)
     VALUES ($1, 'feature', 'DEVELOP', $2, '[]') RETURNING id`,
		[`P3535 test ${Math.random()}`, maturity],
	);
	return r.rows[0].id;
}

async function insertLease(proposalId: number): Promise<number> {
	const r = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal_lease (proposal_id, agent_identity, expires_at)
     VALUES ($1, $2, now() + interval '30 minutes') RETURNING id`,
		[proposalId, AGENT],
	);
	return r.rows[0].id;
}

async function releaseLease(leaseId: number, reason: string): Promise<void> {
	await query(
		`UPDATE roadmap_proposal.proposal_lease SET released_at = now(), release_reason = $1 WHERE id = $2`,
		[reason, leaseId],
	);
}

async function getMaturity(proposalId: number): Promise<string> {
	const r = await query<{ maturity: string }>(
		`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	return r.rows[0].maturity;
}

async function cleanup(proposalId: number): Promise<void> {
	await query(`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`, [proposalId]);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
}

describe("P3535 — Monotonic maturity lifecycle", () => {
	before(async () => {
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
       VALUES ($1, 'llm', 'active') ON CONFLICT DO NOTHING`,
			[AGENT],
		);
	});

	describe("AC-1 / AC-5: claim does not flip active or mature", () => {
		it("claiming a new proposal sets active (new→active edge)", async () => {
			const id = await createProposal("new");
			try {
				await insertLease(id);
				assert.equal(await getMaturity(id), "active");
			} finally { await cleanup(id); }
		});

		it("claiming an already-active proposal leaves it active", async () => {
			const id = await createProposal("active");
			try {
				await insertLease(id);
				assert.equal(await getMaturity(id), "active");
			} finally { await cleanup(id); }
		});

		it("claiming a mature proposal leaves it mature (AC-5)", async () => {
			const id = await createProposal("mature");
			try {
				await insertLease(id);
				assert.equal(await getMaturity(id), "mature", "gate claim must not flip mature→active");
			} finally { await cleanup(id); }
		});
	});

	describe("AC-2: active is sticky", () => {
		it("lease_expired release does not revert active to new", async () => {
			const id = await createProposal("new");
			try {
				const lid = await insertLease(id);
				assert.equal(await getMaturity(id), "active");
				await releaseLease(lid, "lease_expired");
				assert.equal(await getMaturity(id), "active", "active must survive lease_expired");
			} finally { await cleanup(id); }
		});

		it("re-claim after release leaves maturity active", async () => {
			const id = await createProposal("new");
			try {
				const lid = await insertLease(id);
				await releaseLease(lid, "released_unfinished");
				await insertLease(id);
				assert.equal(await getMaturity(id), "active");
			} finally { await cleanup(id); }
		});

		it("send-back release on active proposal keeps it active (not new)", async () => {
			const id = await createProposal("active");
			try {
				const lid = await insertLease(id);
				await releaseLease(lid, "gate_hold");
				assert.equal(await getMaturity(id), "active", "gate_hold on active must not demote to new");
			} finally { await cleanup(id); }
		});
	});

	describe("AC-3: active→mature via work_complete reasons preserved", () => {
		for (const reason of ["work_delivered", "gate_review_complete", "authored_complete"] as const) {
			it(`${reason} transitions active→mature`, async () => {
				const id = await createProposal("new");
				try {
					const lid = await insertLease(id);
					assert.equal(await getMaturity(id), "active");
					await releaseLease(lid, reason);
					assert.equal(await getMaturity(id), "mature");
				} finally { await cleanup(id); }
			});
		}
	});

	describe("AC-6: mature sticky on non-send-back; only send-back resets to new", () => {
		it("send-back reasons reset mature→new", async () => {
			for (const reason of SEND_BACK) {
				const id = await createProposal("mature");
				try {
					const lid = await insertLease(id);
					assert.equal(await getMaturity(id), "mature", `${reason}: gate claim must not flip mature`);
					await releaseLease(lid, reason);
					assert.equal(await getMaturity(id), "new", `${reason}: should reset mature→new`);
				} finally { await cleanup(id); }
			}
		});

		it("non-send-back reasons preserve mature", async () => {
			for (const reason of NON_SEND_BACK) {
				const id = await createProposal("mature");
				try {
					const lid = await insertLease(id);
					await releaseLease(lid, reason);
					assert.equal(await getMaturity(id), "mature", `${reason}: must preserve mature`);
				} finally { await cleanup(id); }
			}
		});
	});

	describe("AC-7: P1391 exclusive-claim objects still exist", () => {
		it("lease_is_live function exists in roadmap_proposal schema", async () => {
			const r = await query<{ cnt: string }>(
				`SELECT count(*)::text AS cnt FROM pg_proc
         WHERE proname = 'lease_is_live'
           AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap_proposal')`,
			);
			assert.equal(r.rows[0].cnt, "1");
		});

		it("proposal_lease_no_overlap_live EXCLUDE constraint exists", async () => {
			const r = await query<{ cnt: string }>(
				`SELECT count(*)::text AS cnt FROM pg_constraint WHERE conname = 'proposal_lease_no_overlap_live'`,
			);
			assert.equal(r.rows[0].cnt, "1");
		});
	});

	describe("AC-9: reconcile restored stuck COMPLETE/active rows", () => {
		it("P144/P463/P518 are now mature (were COMPLETE/active before migration)", async () => {
			const r = await query<{ id: number; maturity: string }>(
				`SELECT id, maturity FROM roadmap_proposal.proposal WHERE id IN (144, 463, 518) ORDER BY id`,
			);
			for (const row of r.rows) {
				assert.equal(row.maturity, "mature", `P${row.id} should be mature after reconcile`);
			}
		});
	});
});
