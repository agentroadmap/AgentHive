/**
 * P1391 — Lease-lifecycle observability views (migration 305).
 *
 * Live-DB integration tests for the two read-only views:
 *   AC-6  roadmap_proposal.v_proposal_review_rounds
 *         hold_count / reject_count / review_round (= 1 + holds + rejects).
 *   AC-7  roadmap_proposal.v_proposal_stale
 *         maturity='active' AND modified_at < now()-7d AND no LIVE lease.
 *
 * Fixture hygiene (this platform has had live-dispatch fixture storms): every
 * inserted proposal is created with maturity='obsolete' (excluded from
 * v_dispatchable_proposal so the orchestrator never picks it up) AND every
 * inserted row is deleted by id in afterAll. We flip maturity to 'active' only
 * transiently inside the AC-7 case while keeping the row obsolete in the
 * dispatch view via gate_scanner_paused=true.
 *
 * Run live:
 *   AGENTHIVE_ALLOW_LIVE_DB=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=admin \
 *   PGDATABASE=agenthive PGPASSWORD=... npx vitest run \
 *   scripts/migrations/__tests__/p1391-lease-lifecycle-views.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../../src/postgres/pool.ts";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
const ACTOR = "system"; // exists in agent_registry; satisfies decided_by FK

describe.skipIf(!LIVE)("P1391 mig-305: lease-lifecycle views", () => {
	// Track every inserted proposal id for guaranteed cleanup.
	const proposalIds: number[] = [];

	async function makeProposal(title: string): Promise<number> {
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (display_id, title, status, type, maturity, project_id, audit,
			    gate_scanner_paused)
			 VALUES ($1, $2, 'DEVELOP', 'feature', 'obsolete', 1, '[]'::jsonb, true)
			 RETURNING id`,
			[`P1391V${Date.now() % 100000}${proposalIds.length}`, title],
		);
		const id = rows[0].id;
		proposalIds.push(id);
		return id;
	}

	async function logDecision(
		proposalId: number,
		decision: "hold" | "reject" | "advance",
	): Promise<void> {
		await query(
			`INSERT INTO roadmap_proposal.gate_decision_log
			   (proposal_id, from_state, to_state, decided_by, decision, project_id)
			 VALUES ($1, 'REVIEW', 'REVIEW', $2, $3, 1)`,
			[proposalId, ACTOR, decision],
		);
	}

	afterAll(async () => {
		for (const id of proposalIds) {
			// Children first to satisfy FKs.
			await query(`DELETE FROM roadmap_proposal.gate_decision_log WHERE proposal_id = $1`, [id]);
			await query(`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`, [id]);
			await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [id]);
		}
	});

	// ── AC-6 ──────────────────────────────────────────────────────────────────
	it("AC-6: two hold rows ⇒ hold_count=2, review_round=3", async () => {
		const pid = await makeProposal("P1391 AC-6 two-hold fixture");
		await logDecision(pid, "hold");
		await logDecision(pid, "hold");

		const { rows } = await query<{
			hold_count: string;
			reject_count: string;
			review_round: string;
		}>(
			`SELECT hold_count, reject_count, review_round
			 FROM roadmap_proposal.v_proposal_review_rounds
			 WHERE proposal_id = $1`,
			[pid],
		);
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].hold_count)).toBe(2);
		expect(Number(rows[0].reject_count)).toBe(0);
		expect(Number(rows[0].review_round)).toBe(3);
	});

	it("AC-6: hold + reject ⇒ review_round counts both; no decisions ⇒ round 1", async () => {
		const mixed = await makeProposal("P1391 AC-6 hold+reject fixture");
		await logDecision(mixed, "hold");
		await logDecision(mixed, "reject");
		await logDecision(mixed, "advance"); // must NOT count toward the round

		const m = await query<{ hold_count: string; reject_count: string; review_round: string }>(
			`SELECT hold_count, reject_count, review_round
			 FROM roadmap_proposal.v_proposal_review_rounds WHERE proposal_id = $1`,
			[mixed],
		);
		expect(Number(m.rows[0].hold_count)).toBe(1);
		expect(Number(m.rows[0].reject_count)).toBe(1);
		expect(Number(m.rows[0].review_round)).toBe(3); // 1 + 1 + 1

		const fresh = await makeProposal("P1391 AC-6 no-decision fixture");
		const f = await query<{ review_round: string }>(
			`SELECT review_round FROM roadmap_proposal.v_proposal_review_rounds WHERE proposal_id = $1`,
			[fresh],
		);
		expect(Number(f.rows[0].review_round)).toBe(1);
	});

	// ── AC-7 ──────────────────────────────────────────────────────────────────
	it("AC-7: active + 8d idle + no live lease APPEARS; 1d idle does NOT", async () => {
		// Stale candidate: active, modified 8 days ago, no lease. Kept out of the
		// dispatch view via gate_scanner_paused=true (set at insert).
		const staleId = await makeProposal("P1391 AC-7 stale fixture");
		await query(
			`UPDATE roadmap_proposal.proposal
			 SET maturity = 'active', modified_at = now() - INTERVAL '8 days'
			 WHERE id = $1`,
			[staleId],
		);

		// Recent candidate: active, modified 1 day ago — must NOT appear.
		const recentId = await makeProposal("P1391 AC-7 recent fixture");
		await query(
			`UPDATE roadmap_proposal.proposal
			 SET maturity = 'active', modified_at = now() - INTERVAL '1 day'
			 WHERE id = $1`,
			[recentId],
		);

		const stale = await query<{ proposal_id: number }>(
			`SELECT proposal_id FROM roadmap_proposal.v_proposal_stale WHERE proposal_id = $1`,
			[staleId],
		);
		expect(stale.rows).toHaveLength(1);

		const recent = await query<{ proposal_id: number }>(
			`SELECT proposal_id FROM roadmap_proposal.v_proposal_stale WHERE proposal_id = $1`,
			[recentId],
		);
		expect(recent.rows).toHaveLength(0);
	});

	it("AC-7: a LIVE lease suppresses an otherwise-stale proposal", async () => {
		const leasedId = await makeProposal("P1391 AC-7 live-lease fixture");
		await query(
			`UPDATE roadmap_proposal.proposal
			 SET maturity = 'active', modified_at = now() - INTERVAL '30 days'
			 WHERE id = $1`,
			[leasedId],
		);
		// A live lease: released_at IS NULL AND expires_at in the future.
		await query(
			`INSERT INTO roadmap_proposal.proposal_lease
			   (proposal_id, agent_identity, expires_at)
			 VALUES ($1, $2, now() + INTERVAL '20 minutes')`,
			[leasedId, ACTOR],
		);

		const withLive = await query(
			`SELECT proposal_id FROM roadmap_proposal.v_proposal_stale WHERE proposal_id = $1`,
			[leasedId],
		);
		expect(withLive.rows).toHaveLength(0);

		// Expire the lease (released_at NULL but past TTL) → not live → reappears.
		// claimed_at is moved back too so tstzrange(claimed_at, expires_at) stays
		// valid for the proposal_lease_no_overlap_live EXCLUDE constraint.
		await query(
			`UPDATE roadmap_proposal.proposal_lease
			 SET claimed_at = now() - INTERVAL '1 hour',
			     expires_at = now() - INTERVAL '1 minute'
			 WHERE proposal_id = $1`,
			[leasedId],
		);
		const afterExpiry = await query(
			`SELECT proposal_id FROM roadmap_proposal.v_proposal_stale WHERE proposal_id = $1`,
			[leasedId],
		);
		expect(afterExpiry.rows).toHaveLength(1);
	});
});
