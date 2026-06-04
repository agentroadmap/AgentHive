/**
 * P445 — State Machine Race Integration Tests
 *
 * 28 tests across 7 scenarios proving Postgres-backed race guards behave correctly
 * under concurrent access and failure conditions. Uses Node.js built-in test runner
 * against real Postgres — no mocks.
 *
 * Scenarios:
 *   (a) Duplicate poll advisory lock        — 4 tests
 *   (b) Concurrent claim race              — 5 tests
 *   (c) Retry at max_retries=3             — 4 tests
 *   (d) Cancel closes future claims        — 4 tests
 *   (e) Budget gate                        — 3 tests
 *   (f) Host policy gate                   — 5 tests
 *   (g) Agency suspension blocks claims    — 3 tests
 *
 * Prerequisites: roadmap_control schema + migrations 051+052+053 applied.
 *                roadmap.agency and roadmap.host_model_policy tables present.
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { getPool, query } from "../../src/infra/postgres/pool.ts";
import {
	pollAndCreateDispatch,
	tryClaimDispatch,
	recordRunFailure,
	checkBudgetBeforeSpawn,
	checkHostPolicyBeforeSpawn,
} from "../../src/core/control/state-machine-guards.ts";

const TS = Date.now();
// Postgres dispatch.proposal_id is INTEGER (max 2,147,483,647).
// Date.now() ≈ 1.778e12 overflows it, so we derive a safe base in range.
const PROP_BASE = 445_000_000 + (TS % 1_000_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertDispatch(
	opts: {
		agencyId?: string | null;
		metadata?: Record<string, unknown>;
		status?: string;
	} = {},
): Promise<string> {
	const { rows } = await query<{ dispatch_id: string }>(
		`INSERT INTO roadmap_control.dispatch
		     (proposal_id, project_id, agency_id, worker_id,
		      host, route, model, provider, agent_cli, budget_scope, status, metadata)
		 VALUES (NULL,'p445-test',$1,NULL,'hermes','hermes-3','hermes-3','nous','hermes','budget-p445',$2,$3)
		 RETURNING dispatch_id::text`,
		[
			opts.agencyId ?? null,
			opts.status ?? "pending",
			opts.metadata ? JSON.stringify(opts.metadata) : null,
		],
	);
	return rows[0]!.dispatch_id;
}

async function insertClaim(
	dispatchId: string,
	tag: string,
	status = "active",
): Promise<string> {
	const expiresAt = new Date(Date.now() + 5 * 60_000);
	const { rows } = await query<{ claim_id: string }>(
		`INSERT INTO roadmap_control.claim
		     (dispatch_id, agent_identity, expires_at, status)
		 VALUES ($1::uuid, $2, $3, $4)
		 RETURNING claim_id::text`,
		[dispatchId, `agent-p445-${tag}-${TS}`, expiresAt, status],
	);
	return rows[0]!.claim_id;
}

async function insertRun(
	dispatchId: string,
	claimId: string,
	tag: string,
): Promise<string> {
	const { rows } = await query<{ run_id: string }>(
		`INSERT INTO roadmap_control.run
		     (dispatch_id, claim_id, agent_identity, status)
		 VALUES ($1::uuid, $2::uuid, $3, 'running')
		 RETURNING run_id::text`,
		[dispatchId, claimId, `agent-p445-${tag}-${TS}`],
	);
	return rows[0]!.run_id;
}

async function cleanupDispatch(dispatchId: string): Promise<void> {
	// feed_event has no FK cascade from dispatch; clean it first
	await query(
		`DELETE FROM roadmap_control.feed_event WHERE dispatch_id = $1::uuid`,
		[dispatchId],
	);
	// claim and run cascade from dispatch ON DELETE CASCADE
	await query(
		`DELETE FROM roadmap_control.dispatch WHERE dispatch_id = $1::uuid`,
		[dispatchId],
	);
}

// ─── (a) Duplicate poll advisory lock ────────────────────────────────────────

describe("P445(a): duplicate poll advisory lock — exactly one dispatch created", () => {
	const dispatchIds: string[] = [];

	after(async () => {
		for (const id of dispatchIds) await cleanupDispatch(id);
		// Also clean up any proposal_id-keyed dispatches from the advisory lock tests
		await query(
			`DELETE FROM roadmap_control.dispatch WHERE project_id = 'p445-test' AND proposal_id BETWEEN $1 AND $2`,
			[PROP_BASE + 1, PROP_BASE + 4],
		);
	});

	it("single poll creates a dispatch when none exists", async () => {
		const proposalId = PROP_BASE + 1;
		const result = await pollAndCreateDispatch(proposalId, { project_id: "p445-test" });
		assert.ok("dispatch_id" in result, "must return dispatch_id");
		dispatchIds.push((result as { dispatch_id: string }).dispatch_id);
	});

	it("second poll on same proposalId returns already_dispatched when dispatch is pending", async () => {
		const proposalId = PROP_BASE + 2;
		const first = await pollAndCreateDispatch(proposalId, { project_id: "p445-test" });
		assert.ok("dispatch_id" in first, "first poll must create dispatch");
		dispatchIds.push((first as { dispatch_id: string }).dispatch_id);

		const second = await pollAndCreateDispatch(proposalId, { project_id: "p445-test" });
		assert.deepEqual(second, { skipped: true, reason: "already_dispatched" });
	});

	it("concurrent polls: exactly one dispatch created; the other is skipped", async () => {
		const proposalId = PROP_BASE + 3;
		const [r1, r2] = await Promise.all([
			pollAndCreateDispatch(proposalId, { project_id: "p445-test" }),
			pollAndCreateDispatch(proposalId, { project_id: "p445-test" }),
		]);

		const created = [r1, r2].filter((r) => "dispatch_id" in r) as { dispatch_id: string }[];
		const skipped = [r1, r2].filter((r) => "skipped" in r);

		assert.strictEqual(created.length, 1, "exactly one dispatch must be created");
		assert.strictEqual(skipped.length, 1, "exactly one poller must be skipped");
		if (created[0]) dispatchIds.push(created[0].dispatch_id);
	});

	it("lock contention: advisory lock held by raw connection → skipped=lock_contention", async () => {
		const proposalId = PROP_BASE + 4;
		// Hold the advisory lock in a raw connection so pollAndCreateDispatch cannot acquire it.
		const client = await getPool().connect();
		let result: Awaited<ReturnType<typeof pollAndCreateDispatch>> | null = null;
		try {
			await client.query("BEGIN");
			const { rows: lockRows } = await client.query<{ got_lock: boolean }>(
				"SELECT pg_try_advisory_xact_lock($1::bigint) AS got_lock",
				[proposalId],
			);
			assert.strictEqual(lockRows[0]!.got_lock, true, "raw client must acquire advisory lock");

			// Poll from a different pool connection — must fail to get the lock.
			result = await pollAndCreateDispatch(proposalId, { project_id: "p445-test" });
		} finally {
			await client.query("ROLLBACK"); // releases the advisory lock
			client.release();
		}

		assert.deepEqual(result, { skipped: true, reason: "lock_contention" });

		// No dispatch must have been created while lock was held.
		const { rows } = await query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt FROM roadmap_control.dispatch WHERE proposal_id = $1`,
			[proposalId],
		);
		assert.strictEqual(
			Number(rows[0]!.cnt),
			0,
			"no dispatch row created when advisory lock was contended",
		);
	});
});

// ─── (b) Concurrent claim race ────────────────────────────────────────────────

describe("P445(b): concurrent claim race — one winner, one loser with audit trail", () => {
	let dispatchId: string;
	let winnerClaimId: string | null = null;
	let loserClaimId: string | null = null;
	let winnerCount = 0;
	let loserCount = 0;
	let loserReason: string | null = null;

	before(async () => {
		dispatchId = await insertDispatch();
		const expiresAt = new Date(Date.now() + 5 * 60_000);

		const [r1, r2] = await Promise.all([
			tryClaimDispatch(dispatchId, `agent-p445-b1-${TS}`, expiresAt),
			tryClaimDispatch(dispatchId, `agent-p445-b2-${TS}`, expiresAt),
		]);

		for (const r of [r1, r2]) {
			if (r.won) {
				winnerCount++;
				winnerClaimId = r.claim_id;
			} else {
				loserCount++;
				loserClaimId = r.rejected_claim_id;
				loserReason = r.reason;
			}
		}
	});

	after(async () => {
		await cleanupDispatch(dispatchId);
	});

	it("exactly one claimant wins the race", () => {
		assert.strictEqual(winnerCount, 1, "exactly one winner");
	});

	it("exactly one claimant loses the race", () => {
		assert.strictEqual(loserCount, 1, "exactly one loser");
	});

	it("winner has an active claim row in DB", async () => {
		assert.ok(winnerClaimId, "winnerClaimId must be set");
		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_control.claim WHERE claim_id = $1::uuid`,
			[winnerClaimId],
		);
		assert.strictEqual(rows[0]?.status, "active", "winner claim must be active");
	});

	it("loser has a released claim with reason lost_race or dispatch_closed", async () => {
		assert.ok(loserClaimId, "loserClaimId must be set");
		const { rows } = await query<{ status: string; release_reason: string }>(
			`SELECT status, release_reason FROM roadmap_control.claim WHERE claim_id = $1::uuid`,
			[loserClaimId],
		);
		assert.strictEqual(rows[0]?.status, "released", "loser claim must be released");
		assert.ok(
			["lost_race", "dispatch_closed"].includes(rows[0]!.release_reason),
			`loser reason must be lost_race or dispatch_closed, got: ${rows[0]?.release_reason}`,
		);
	});

	it("dispatch status is running after the winner claims", async () => {
		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_control.dispatch WHERE dispatch_id = $1::uuid`,
			[dispatchId],
		);
		assert.strictEqual(rows[0]?.status, "running", "dispatch must be running after winner claims");
	});
});

// ─── (c) Retry at max_retries=3 ──────────────────────────────────────────────

describe("P445(c): retry policy — 3 failures mark dispatch terminal and emit feed event", () => {
	let dispatchId: string;
	let claimId: string;
	const MAX_RETRIES = 3;

	before(async () => {
		dispatchId = await insertDispatch({ status: "running" });
		claimId = await insertClaim(dispatchId, "c-seed", "active");
	});

	after(async () => {
		await cleanupDispatch(dispatchId);
	});

	it("first failure is non-terminal (failure_count=1)", async () => {
		const runId = await insertRun(dispatchId, claimId, "c-run1");
		const result = await recordRunFailure(dispatchId, runId, 1, { max_retries: MAX_RETRIES });
		assert.strictEqual(result.terminal, false, "first failure must not be terminal");
		assert.strictEqual(result.failure_count, 1);
	});

	it("second failure is non-terminal (failure_count=2)", async () => {
		const runId = await insertRun(dispatchId, claimId, "c-run2");
		const result = await recordRunFailure(dispatchId, runId, 1, { max_retries: MAX_RETRIES });
		assert.strictEqual(result.terminal, false, "second failure must not be terminal");
		assert.strictEqual(result.failure_count, 2);
	});

	it("third failure is terminal (failure_count=3, terminal=true)", async () => {
		const runId = await insertRun(dispatchId, claimId, "c-run3");
		const result = await recordRunFailure(dispatchId, runId, 1, { max_retries: MAX_RETRIES });
		assert.strictEqual(result.terminal, true, "third failure at max_retries must be terminal");
		assert.strictEqual(result.failure_count, MAX_RETRIES);
	});

	it("dispatch status is failed and dispatch_failed feed event was emitted", async () => {
		const { rows: dRows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_control.dispatch WHERE dispatch_id = $1::uuid`,
			[dispatchId],
		);
		assert.strictEqual(dRows[0]?.status, "failed", "dispatch must be failed after max_retries");

		const { rows: eRows } = await query<{ event_class: string; severity: string }>(
			`SELECT event_class, severity
			   FROM roadmap_control.feed_event
			  WHERE dispatch_id = $1::uuid
			    AND event_class = 'dispatch_failed'`,
			[dispatchId],
		);
		assert.ok(eRows.length > 0, "dispatch_failed feed event must exist");
		assert.strictEqual(eRows[0]!.severity, "error", "feed event severity must be error");
	});
});

// ─── (d) Cancel closes future claims ─────────────────────────────────────────

describe("P445(d): cancelled dispatch blocks all further claim attempts", () => {
	let dispatchId: string;

	before(async () => {
		dispatchId = await insertDispatch({ status: "pending" });
		await query(
			`UPDATE roadmap_control.dispatch SET status = 'cancelled' WHERE dispatch_id = $1::uuid`,
			[dispatchId],
		);
	});

	after(async () => {
		await cleanupDispatch(dispatchId);
	});

	it("tryClaimDispatch on cancelled dispatch returns won=false", async () => {
		const expiresAt = new Date(Date.now() + 5 * 60_000);
		const result = await tryClaimDispatch(dispatchId, `agent-p445-d1-${TS}`, expiresAt);
		assert.strictEqual(result.won, false, "claim must fail for cancelled dispatch");
	});

	it("rejection reason is dispatch_closed", async () => {
		const expiresAt = new Date(Date.now() + 5 * 60_000);
		const result = await tryClaimDispatch(dispatchId, `agent-p445-d2-${TS}`, expiresAt);
		assert.strictEqual(result.won, false);
		assert.strictEqual(
			(result as { won: false; reason: string }).reason,
			"dispatch_closed",
			"reason must be dispatch_closed for cancelled dispatch",
		);
	});

	it("released claim row has release_reason=dispatch_closed", async () => {
		const { rows } = await query<{ status: string; release_reason: string }>(
			`SELECT status, release_reason
			   FROM roadmap_control.claim
			  WHERE dispatch_id = $1::uuid
			    AND status = 'released'
			  ORDER BY claimed_at DESC
			  LIMIT 1`,
			[dispatchId],
		);
		assert.ok(rows[0], "must have at least one released claim for cancelled dispatch");
		assert.strictEqual(rows[0]!.release_reason, "dispatch_closed");
	});

	it("no active claims exist for the cancelled dispatch", async () => {
		const { rows } = await query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			   FROM roadmap_control.claim
			  WHERE dispatch_id = $1::uuid
			    AND status = 'active'`,
			[dispatchId],
		);
		assert.strictEqual(
			Number(rows[0]!.cnt),
			0,
			"cancelled dispatch must have no active claims",
		);
	});
});

// ─── (e) Budget gate ──────────────────────────────────────────────────────────

describe("P445(e): budget gate — checkBudgetBeforeSpawn blocks when budget_exhausted is set", () => {
	let dispatchId: string;
	let exhaustedDispatchId: string;

	before(async () => {
		dispatchId = await insertDispatch();
		exhaustedDispatchId = await insertDispatch({ metadata: { budget_exhausted: "true" } });
	});

	after(async () => {
		await cleanupDispatch(dispatchId);
		await cleanupDispatch(exhaustedDispatchId);
	});

	it("dispatch without budget flag → allowed=true", async () => {
		const result = await checkBudgetBeforeSpawn(dispatchId);
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.reason, "ok");
	});

	it("dispatch with metadata.budget_exhausted=true → allowed=false", async () => {
		const result = await checkBudgetBeforeSpawn(exhaustedDispatchId);
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, "budget_exhausted");
	});

	it("non-existent dispatch_id → allowed=false with dispatch_not_found", async () => {
		const fakeId = "00000000-0000-0000-0000-000000000000";
		const result = await checkBudgetBeforeSpawn(fakeId);
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, "dispatch_not_found");
	});
});

// ─── (f) Host policy gate ─────────────────────────────────────────────────────

describe("P445(f): host policy gate — fn_check_spawn_policy enforced before spawn", () => {
	const HOST_CUSTOM = `p445-host-${TS}`;
	const HOST_OPEN = `p445-open-${TS}`;

	before(async () => {
		// Custom host: forbidden=['anthropic'], allowed=['nous']
		await query(
			`INSERT INTO roadmap.host_model_policy (host_name, allowed_providers, forbidden_providers)
			 VALUES ($1, ARRAY['nous'], ARRAY['anthropic'])
			 ON CONFLICT (host_name) DO UPDATE
			     SET allowed_providers   = EXCLUDED.allowed_providers,
			         forbidden_providers = EXCLUDED.forbidden_providers`,
			[HOST_CUSTOM],
		);
		// Open host: empty allow-list (permit any non-forbidden provider)
		await query(
			`INSERT INTO roadmap.host_model_policy (host_name, allowed_providers, forbidden_providers)
			 VALUES ($1, ARRAY[]::text[], ARRAY[]::text[])
			 ON CONFLICT (host_name) DO UPDATE
			     SET allowed_providers   = EXCLUDED.allowed_providers,
			         forbidden_providers = EXCLUDED.forbidden_providers`,
			[HOST_OPEN],
		);
	});

	after(async () => {
		await query(
			`DELETE FROM roadmap.host_model_policy WHERE host_name IN ($1, $2)`,
			[HOST_CUSTOM, HOST_OPEN],
		);
	});

	it("unknown host + anthropic → denied (default deny for unknown hosts)", async () => {
		const result = await checkHostPolicyBeforeSpawn("p445-no-such-host", "anthropic");
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, "host_policy_denied");
	});

	it("unknown host + nous → allowed (unknown host only restricts anthropic)", async () => {
		const result = await checkHostPolicyBeforeSpawn("p445-no-such-host", "nous");
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.reason, "ok");
	});

	it("custom host: explicitly forbidden provider (anthropic) → denied", async () => {
		const result = await checkHostPolicyBeforeSpawn(HOST_CUSTOM, "anthropic");
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, "host_policy_denied");
	});

	it("custom host: explicitly allowed provider (nous) → allowed", async () => {
		const result = await checkHostPolicyBeforeSpawn(HOST_CUSTOM, "nous");
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.reason, "ok");
	});

	it("host with empty allowed_providers → permits any non-forbidden provider", async () => {
		const result = await checkHostPolicyBeforeSpawn(HOST_OPEN, "openai");
		assert.strictEqual(result.allowed, true, "empty allow-list host must permit any provider");
		assert.strictEqual(result.reason, "ok");
	});
});

// ─── (g) Agency suspension blocks claims ─────────────────────────────────────

describe("P445(g): paused agency blocks all claim attempts with agency_suspended reason", () => {
	const AGENCY_ID = `agency-p445-paused-${TS}`;
	const HOST_G = `p445-host-g-${TS}`;
	let dispatchId: string;

	before(async () => {
		// Ensure a host_model_policy row exists so the agency FK is satisfied.
		await query(
			`INSERT INTO roadmap.host_model_policy (host_name, allowed_providers, forbidden_providers)
			 VALUES ($1, ARRAY[]::text[], ARRAY[]::text[])
			 ON CONFLICT (host_name) DO NOTHING`,
			[HOST_G],
		);
		// Insert a paused agency against the test host.
		await query(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
			 VALUES ($1, 'P445 Paused Test Agency', 'nous', $2, 'paused')
			 ON CONFLICT (agency_id) DO UPDATE SET status = 'paused'`,
			[AGENCY_ID, HOST_G],
		);
		dispatchId = await insertDispatch({ agencyId: AGENCY_ID });
	});

	after(async () => {
		await cleanupDispatch(dispatchId);
		await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [AGENCY_ID]);
		await query(`DELETE FROM roadmap.host_model_policy WHERE host_name = $1`, [HOST_G]);
	});

	it("claim attempt on dispatch with paused agency returns won=false", async () => {
		const expiresAt = new Date(Date.now() + 5 * 60_000);
		const result = await tryClaimDispatch(dispatchId, `agent-p445-g1-${TS}`, expiresAt);
		assert.strictEqual(result.won, false, "paused agency must reject claim");
	});

	it("rejection reason is agency_suspended", async () => {
		const expiresAt = new Date(Date.now() + 5 * 60_000);
		const result = await tryClaimDispatch(dispatchId, `agent-p445-g2-${TS}`, expiresAt);
		assert.strictEqual(result.won, false);
		assert.strictEqual(
			(result as { won: false; reason: string }).reason,
			"agency_suspended",
			"reason must be agency_suspended for paused agency",
		);
	});

	it("no active claims exist for dispatch with paused agency", async () => {
		const { rows } = await query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			   FROM roadmap_control.claim
			  WHERE dispatch_id = $1::uuid
			    AND status = 'active'`,
			[dispatchId],
		);
		assert.strictEqual(
			Number(rows[0]!.cnt),
			0,
			"paused agency must yield no active claims",
		);
	});
});
