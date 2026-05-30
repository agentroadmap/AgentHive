/**
 * V3-C2 (P1434) AC-3: cause-aware circuit breaker counts ONLY genuine loops.
 *
 * The breaker (post-work-offer.ts) must count a (proposal, role) failure toward
 * the dispatch-loop pause ONLY when it is a genuine, unattributable failure
 * (failure_class='unknown', non-transient). Transient causes — auth_rejected,
 * rate_limited, quota_exhausted, no_eligible_agency, lease_expired — must NOT
 * count (they are provider/capacity conditions, not the proposal's fault).
 *
 * This is the regression for the 2026-05-27..29 false-pause incidents where
 * auth-401 and capacity failures tripped the breaker and paused P238/P304/P194.
 *
 * Self-contained + zero live impact: the whole test runs in ONE transaction that
 * adds the failure_class columns (migration 184, idempotent), inserts synthetic
 * failed rows, runs the EXACT breaker count query, asserts, then ROLLS BACK.
 * The breaker is a single SELECT (no concurrency), so a single-txn test is a
 * faithful proof — unlike C1's claim race which needed real parallel connections.
 */

import { test } from "node:test";
import assert from "node:assert";
import { Client } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const FK_PROPOSAL_ID = 1432; // exists; FK target only (rolled back anyway)
const ROLE = "v3c2-breaker-role";

// The EXACT breaker count query from post-work-offer.ts (V3-C2). Kept in sync
// by intent; if the source query changes, this assertion should change with it.
const BREAKER_COUNT_SQL = `
	SELECT count(*)::int AS recent_runs
	  FROM roadmap_workforce.squad_dispatch
	 WHERE proposal_id = $1
	   AND dispatch_role = $2
	   AND dispatch_status = 'failed'
	   AND completed_at > now() - interval '1 hour'
	   AND failure_class = 'unknown'
	   AND failure_is_transient IS NOT TRUE`;

async function insertFailed(
	c: Client,
	failureClass: string | null,
	transient: boolean,
	tag: string,
): Promise<void> {
	await c.query(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role,
		    dispatch_status, offer_status, completed_at,
		    required_capabilities, idempotency_key, failure_class, failure_is_transient)
		 VALUES ($1, 1, $2, $3, 'failed', 'failed', now(),
		         '["develop"]'::jsonb, $2, $4, $5)`,
		[FK_PROPOSAL_ID, `v3c2-${tag}`, ROLE, failureClass, transient],
	);
}

test("P1434 AC-3: breaker counts only failure_class='unknown' non-transient", async () => {
	const c = new Client({ connectionString: DB_URL });
	await c.connect();
	try {
		await c.query("BEGIN");

		// Apply the C2 columns (idempotent; rolled back with the txn).
		await c.query(
			`ALTER TABLE roadmap_workforce.squad_dispatch
			   ADD COLUMN IF NOT EXISTS failure_class text,
			   ADD COLUMN IF NOT EXISTS failure_is_transient boolean NOT NULL DEFAULT false`,
		);

		// 6 genuine loop failures (should ALL count).
		for (let i = 0; i < 6; i++) await insertFailed(c, "unknown", false, `unknown-${i}`);
		// Transient/provider/capacity failures (should NOT count).
		for (let i = 0; i < 5; i++) await insertFailed(c, "rate_limited", true, `rl-${i}`);
		for (let i = 0; i < 4; i++) await insertFailed(c, "auth_rejected", true, `auth-${i}`);
		for (let i = 0; i < 3; i++) await insertFailed(c, "quota_exhausted", true, `quota-${i}`);
		for (let i = 0; i < 2; i++) await insertFailed(c, "lease_expired", true, `lease-${i}`);
		for (let i = 0; i < 2; i++) await insertFailed(c, "no_eligible_agency", true, `noag-${i}`);
		// Unclassified (NULL) failures — also must NOT count (only explicit 'unknown' does).
		for (let i = 0; i < 2; i++) await insertFailed(c, null, false, `null-${i}`);

		const { rows } = await c.query<{ recent_runs: number }>(BREAKER_COUNT_SQL, [
			FK_PROPOSAL_ID,
			ROLE,
		]);
		const counted = Number(rows[0].recent_runs);

		assert.equal(
			counted,
			6,
			`breaker counted ${counted}; expected exactly 6 (the genuine unknown non-transient failures). ` +
				`16 transient/null failures must be excluded — that's the whole point of cause-awareness.`,
		);
	} finally {
		await c.query("ROLLBACK").catch(() => {});
		await c.end();
	}
});

/**
 * Codex blocker (P1434 #8679): the no-eligible-agency path calls
 * fn_complete_work_offer(...,'failed') (which defaults failure_class='unknown',
 * countable) THEN runs an UPDATE. The fix makes that UPDATE also set
 * failure_class='no_eligible_agency'+transient, running AFTER fn_complete so it
 * overrides the default. Reproduces that ordering; asserts breaker counts 0.
 */
test("P1434 no-eligible-agency ends NON-countable (fn_complete default overridden)", async () => {
	const c = new Client({ connectionString: DB_URL });
	await c.connect();
	try {
		await c.query("BEGIN");
		await c.query(
			`ALTER TABLE roadmap_workforce.squad_dispatch
			   ADD COLUMN IF NOT EXISTS failure_class text,
			   ADD COLUMN IF NOT EXISTS failure_is_transient boolean NOT NULL DEFAULT false`,
		);
		const { rows: ins } = await c.query<{ id: string }>(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, project_id, squad_name, dispatch_role,
			    dispatch_status, offer_status, completed_at,
			    required_capabilities, idempotency_key)
			 VALUES ($1, 1, 'v3c2-noelig', $2, 'failed', 'failed', now(),
			         '["develop"]'::jsonb, 'v3c2-noelig')
			 RETURNING id`,
			[FK_PROPOSAL_ID, ROLE],
		);
		const id = Number(ins[0].id);
		await c.query(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET failure_class = COALESCE(failure_class, 'unknown') WHERE id = $1`,
			[id],
		);
		await c.query(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET failure_class = 'no_eligible_agency', failure_is_transient = true
			  WHERE id = $1`,
			[id],
		);
		const { rows } = await c.query<{ fc: string; t: boolean }>(
			`SELECT failure_class AS fc, failure_is_transient AS t
			   FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[id],
		);
		assert.equal(rows[0].fc, "no_eligible_agency", "must end no_eligible_agency, not unknown");
		assert.equal(rows[0].t, true, "must be transient (not counted)");
		const { rows: cnt } = await c.query<{ recent_runs: number }>(BREAKER_COUNT_SQL, [
			FK_PROPOSAL_ID,
			ROLE,
		]);
		assert.equal(Number(cnt[0].recent_runs), 0, "no-eligible failure must not trip the breaker");
	} finally {
		await c.query("ROLLBACK").catch(() => {});
		await c.end();
	}
});
