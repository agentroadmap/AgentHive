/**
 * P439 — Concurrency Ceiling Integration Tests
 *
 * AC#6: 10 concurrent claims on a single agency hitting the per-agency=10 cap:
 *   - first 10 succeed
 *   - 11th is rejected with reason='concurrency_ceiling_exceeded'
 *   - once one active claim is released, the 11th dispatch can be claimed
 *
 * Requires: roadmap_control schema + migrations 051 + 052 + 053 applied.
 *           roadmap.agency table (for agency status JOIN in tryClaimDispatch).
 *
 * Race harness: Promise.all fires 11 concurrent tryClaimDispatch calls.
 * PostgreSQL serializes the concurrency ceiling check via FOR UPDATE on the
 * per-agency concurrency_limit row — no application-level mutexes needed.
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/infra/postgres/pool.ts";
import { tryClaimDispatch } from "../../src/core/control/state-machine-guards.ts";

const TS = Date.now();
const AGENCY = `agency-p439-${TS}`;
const CAP = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertDispatch(tag: string): Promise<string> {
	const { rows } = await query<{ dispatch_id: string }>(
		`INSERT INTO roadmap_control.dispatch
		     (proposal_id, project_id, agency_id, worker_id,
		      host, route, model, provider, agent_cli, budget_scope, status)
		 VALUES (NULL,'p439-test',$1,$2,'hermes','hermes-3','hermes-3','nous','hermes','budget-p439','pending')
		 RETURNING dispatch_id::text`,
		[AGENCY, `worker-${tag}`],
	);
	return rows[0]!.dispatch_id;
}

async function cleanupDispatch(dispatchId: string): Promise<void> {
	await query(`DELETE FROM roadmap_control.claim    WHERE dispatch_id = $1`, [dispatchId]);
	await query(`DELETE FROM roadmap_control.dispatch WHERE dispatch_id = $1`, [dispatchId]);
}

// ─── Scenario: 11 concurrent claims on agency with cap=10 ────────────────────

describe("P439: concurrency ceilings — agency cap=10 blocks the 11th concurrent claim", () => {
	const dispatchIds: string[] = [];
	let loserDispatchId: string | null = null;

	before(async () => {
		// Seed an explicit per-agency cap of CAP for this test run.
		// ON CONFLICT DO UPDATE handles re-runs without leaving stale rows.
		await query(
			`INSERT INTO roadmap_control.concurrency_limit
			     (scope_type, scope_id, max_active_claims, max_active_workers)
			 VALUES ('agency', $1, $2, $2)
			 ON CONFLICT (scope_type, scope_id) DO UPDATE
			     SET max_active_claims  = EXCLUDED.max_active_claims,
			         max_active_workers = EXCLUDED.max_active_workers`,
			[AGENCY, CAP],
		);

		// Create CAP+1 = 11 pending dispatches, all under the same agency.
		for (let i = 0; i < CAP + 1; i++) {
			dispatchIds.push(await insertDispatch(`${i}-${TS}`));
		}
	});

	it(`${CAP} concurrent tryClaimDispatch calls win; the ${CAP + 1}th is rejected`, async () => {
		const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

		const indexed = dispatchIds.map((dId, i) => ({ dId, i }));
		const results = await Promise.all(
			indexed.map(({ dId, i }) =>
				tryClaimDispatch(dId, `agent-p439-${i}-${TS}`, expiresAt).then((r) => ({ r, dId })),
			),
		);

		const winners = results.filter(({ r }) => r.won);
		const losers = results.filter(({ r }) => !r.won);

		assert.strictEqual(winners.length, CAP, `exactly ${CAP} agents must win the race`);
		assert.strictEqual(losers.length, 1, "exactly 1 agent must be rejected");

		const loser = losers[0]!;
		const loserReason = (loser.r as { won: false; reason: string }).reason;
		assert.strictEqual(
			loserReason,
			"concurrency_ceiling_exceeded",
			"loser reason must be concurrency_ceiling_exceeded",
		);

		// Capture loser dispatch ID for subsequent assertions.
		loserDispatchId = loser.dId;
	});

	it("loser dispatch is still pending in DB (was never claimed)", async () => {
		assert.ok(loserDispatchId, "loserDispatchId must be set by the previous test");
		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_control.dispatch WHERE dispatch_id = $1`,
			[loserDispatchId],
		);
		assert.strictEqual(rows[0]?.status, "pending", "loser dispatch must remain pending");
	});

	it("loser claim row carries reason=concurrency_ceiling_exceeded", async () => {
		const { rows } = await query<{ release_reason: string; status: string }>(
			`SELECT release_reason, status
			   FROM roadmap_control.claim
			  WHERE dispatch_id = $1
			    AND status = 'released'`,
			[loserDispatchId!],
		);
		assert.ok(rows[0], "must have a released claim row for the loser dispatch");
		assert.strictEqual(rows[0]!.release_reason, "concurrency_ceiling_exceeded");
	});

	it(`active claim count for agency is exactly ${CAP}`, async () => {
		const { rows } = await query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			   FROM roadmap_control.claim  c
			   JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
			  WHERE c.status    = 'active'
			    AND d.agency_id = $1`,
			[AGENCY],
		);
		assert.strictEqual(Number(rows[0]!.cnt), CAP, `must have exactly ${CAP} active claims`);
	});

	it("after releasing one active claim, the 11th dispatch can be claimed", async () => {
		// Release one of the winners' active claims so the ceiling drops to CAP-1.
		const { rows: activeClaims } = await query<{ claim_id: string }>(
			`SELECT c.claim_id::text
			   FROM roadmap_control.claim  c
			   JOIN roadmap_control.dispatch d ON d.dispatch_id = c.dispatch_id
			  WHERE c.status    = 'active'
			    AND d.agency_id = $1
			  LIMIT 1`,
			[AGENCY],
		);
		assert.ok(activeClaims[0], "must have an active claim to release");
		await query(
			`UPDATE roadmap_control.claim SET status = 'released' WHERE claim_id = $1`,
			[activeClaims[0]!.claim_id],
		);

		// The loser dispatch is still pending — retry now succeeds.
		const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
		const result = await tryClaimDispatch(
			loserDispatchId!,
			`agent-p439-retry-${TS}`,
			expiresAt,
		);
		assert.strictEqual(result.won, true, "retry must succeed after a claim is released");
	});

	it("v_concurrency_usage shows agency at ceiling after retry", async () => {
		// After the retry, active count returns to CAP (9 remaining + 1 retry winner).
		const { rows } = await query<{
			current_active_claims: number;
			at_ceiling: boolean;
		}>(
			`SELECT current_active_claims, at_ceiling
			   FROM roadmap_control.v_concurrency_usage
			  WHERE scope_type = 'agency'
			    AND scope_id   = $1`,
			[AGENCY],
		);
		assert.ok(rows[0], "must have a v_concurrency_usage row for the agency");
		assert.strictEqual(rows[0]!.current_active_claims, CAP, `current must be ${CAP}`);
		assert.strictEqual(rows[0]!.at_ceiling, true, "agency must be at ceiling again");
	});

	after(async () => {
		for (const dId of dispatchIds) {
			await cleanupDispatch(dId);
		}
		await query(
			`DELETE FROM roadmap_control.concurrency_limit
			  WHERE scope_type = 'agency' AND scope_id = $1`,
			[AGENCY],
		);
	});
});

// ─── Scenario: 3 concurrent claims on same proposal hitting cap=2 ─────────────
//
// Exercises the proposal-level ceiling path added to tryClaimDispatch.
// Dispatches have agency_id=NULL so only the proposal ceiling fires.
// fn_check_concurrency('proposal', ...) acquires FOR UPDATE on the proposal
// concurrency_limit row, serializing the three concurrent transactions so the
// count is accurate even with Promise.all.

describe("P439: proposal-level ceiling blocks the 3rd concurrent claim on the same proposal", () => {
	const PROPOSAL_ID = 999439; // test-only synthetic proposal id
	const PROP_CAP = 2;
	const propDispatchIds: string[] = [];

	before(async () => {
		await query(
			`INSERT INTO roadmap_control.concurrency_limit
			     (scope_type, scope_id, max_active_claims, max_active_workers)
			 VALUES ('proposal', $1, $2, $2)
			 ON CONFLICT (scope_type, scope_id) DO UPDATE
			     SET max_active_claims  = EXCLUDED.max_active_claims,
			         max_active_workers = EXCLUDED.max_active_workers`,
			[PROPOSAL_ID.toString(), PROP_CAP],
		);

		for (let i = 0; i < PROP_CAP + 1; i++) {
			const { rows } = await query<{ dispatch_id: string }>(
				`INSERT INTO roadmap_control.dispatch
				     (proposal_id, project_id, agency_id, worker_id,
				      host, route, model, provider, agent_cli, budget_scope, status)
				 VALUES ($1, 'p439-prop-test', NULL, $2,
				         'hermes', 'hermes-3', 'hermes-3', 'nous', 'hermes', 'budget-p439', 'pending')
				 RETURNING dispatch_id::text`,
				[PROPOSAL_ID, `worker-prop-${i}-${TS}`],
			);
			propDispatchIds.push(rows[0]!.dispatch_id);
		}
	});

	it(`${PROP_CAP} concurrent tryClaimDispatch calls win; the ${PROP_CAP + 1}th is rejected at proposal ceiling`, async () => {
		const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

		const results = await Promise.all(
			propDispatchIds.map((dId, i) =>
				tryClaimDispatch(dId, `agent-prop-${i}-${TS}`, expiresAt).then((r) => ({ r, dId })),
			),
		);

		const winners = results.filter(({ r }) => r.won);
		const losers = results.filter(({ r }) => !r.won);

		assert.strictEqual(winners.length, PROP_CAP, `exactly ${PROP_CAP} agents must win within proposal cap`);
		assert.strictEqual(losers.length, 1, "exactly 1 agent must be rejected at proposal ceiling");

		const loserReason = (losers[0]!.r as { won: false; reason: string }).reason;
		assert.strictEqual(loserReason, "concurrency_ceiling_exceeded");
	});

	it("loser dispatch remains pending (never claimed)", async () => {
		const loserDId = propDispatchIds.find((dId) => {
			// The dispatch with no active claim is the loser.
			return true; // resolved below via DB query
		});
		const { rows } = await query<{ dispatch_id: string }>(
			`SELECT d.dispatch_id::text
			   FROM roadmap_control.dispatch d
			   LEFT JOIN roadmap_control.claim c ON c.dispatch_id = d.dispatch_id
			                                    AND c.status = 'active'
			  WHERE d.proposal_id = $1
			    AND c.claim_id IS NULL`,
			[PROPOSAL_ID],
		);
		assert.strictEqual(rows.length, 1, "exactly one dispatch must remain unclaimed");
		assert.ok(propDispatchIds.includes(rows[0]!.dispatch_id));
	});

	it("v_concurrency_usage shows proposal at ceiling", async () => {
		const { rows } = await query<{ current_active_claims: number; at_ceiling: boolean }>(
			`SELECT current_active_claims, at_ceiling
			   FROM roadmap_control.v_concurrency_usage
			  WHERE scope_type = 'proposal'
			    AND scope_id   = $1`,
			[PROPOSAL_ID.toString()],
		);
		assert.ok(rows[0], "v_concurrency_usage must have a row for this proposal");
		assert.strictEqual(rows[0]!.current_active_claims, PROP_CAP);
		assert.strictEqual(rows[0]!.at_ceiling, true);
	});

	after(async () => {
		for (const dId of propDispatchIds) {
			await cleanupDispatch(dId);
		}
		await query(
			`DELETE FROM roadmap_control.concurrency_limit
			  WHERE scope_type = 'proposal' AND scope_id = $1`,
			[PROPOSAL_ID.toString()],
		);
	});
});
