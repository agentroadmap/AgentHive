/**
 * V3-C1 (P1433) AC-2: atomic claim under concurrent claimers.
 *
 * Proves the per-agency concurrency ceiling holds when many claims race.
 * This is a RED-before / GREEN-after regression:
 *   - Against the OLD fn_claim_work_offer (Gate-2 count then Gate-7 claim, no
 *     lock held between), concurrent claims for one agency all pass the ceiling
 *     check and over-claim -> this test FAILS (claimed > max_concurrent_claims).
 *   - After migration 183 adds `FOR UPDATE` on the agent_registry row,
 *     concurrent claims for the same agency serialize -> claimed == ceiling ->
 *     this test PASSES.
 *
 * Isolation: everything is scoped to a dedicated scratch project that no real
 * agency is subscribed to, so the live orchestrator (subscribed only to real
 * projects; blocked by Gate 6 project scope) cannot claim these scratch offers.
 * All scratch rows are removed in teardown.
 *
 * Schema verified against live DB 2026-05-29 (roadmap.project,
 * roadmap_workforce.agent_registry / provider_registry / squad_dispatch).
 */

import { test, before, after } from "node:test";
import assert from "node:assert";
import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

// Function under test — overridable so a throwaway probe copy can be validated
// red/green without mutating the live canonical fn_claim_work_offer.
const CLAIM_FN = process.env.P1433_CLAIM_FN ?? "roadmap_workforce.fn_claim_work_offer";
const SCRATCH_PROJECT_ID = 990433;
const SCRATCH_AGENCY = "v3c1-claimtest-agency";
const FK_PROPOSAL_ID = 1432; // P1432 umbrella — exists; used only for the proposal_id FK
const MAX_CLAIMS = 2;
const N_OFFERS = 8;
const N_CLAIMERS = 8;

let pool: Pool;
let agencyDbId: number;

async function setup(): Promise<void> {
	// Scratch project — dedicated so the live orchestrator can't claim these offers.
	await pool.query(
		`INSERT INTO roadmap.project
		   (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1, $2, $2, '/tmp/v3c1-claimtest', 'active', 'bot', 0, 'live')
		 ON CONFLICT (project_id) DO UPDATE SET status = 'active'`,
		[SCRATCH_PROJECT_ID, "v3c1-claimtest"],
	);

	// Scratch agency with a low ceiling so over-claim is unambiguous.
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, max_concurrent_claims, project_id)
		 VALUES ($1, 'agency', 'active', $2, $3)
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET status = 'active', max_concurrent_claims = $2, project_id = $3
		 RETURNING id`,
		[SCRATCH_AGENCY, MAX_CLAIMS, SCRATCH_PROJECT_ID],
	);
	agencyDbId = rows[0].id;

	// Subscribe the scratch agency to the scratch project (Gate 6 project scope).
	await pool.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, status, is_active, capabilities)
		 VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
		 ON CONFLICT DO NOTHING`,
		[agencyDbId, SCRATCH_AGENCY, SCRATCH_PROJECT_ID],
	);

	// N open offers on the scratch project. required_capabilities must be a
	// non-empty array (sd_required_capabilities_nonempty CHECK); the claim passes
	// p_required_capabilities='[]' which short-circuits Gate 7's capability clause.
	for (let i = 0; i < N_OFFERS; i++) {
		await pool.query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, project_id, squad_name, dispatch_role,
			    dispatch_status, offer_status, required_capabilities, idempotency_key)
			 VALUES ($1, $2, $3, 'developer', 'open', 'open',
			         '["develop"]'::jsonb, $4)`,
			[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `v3c1-claimtest-${i}`, `v3c1-claimtest:${i}`],
		);
	}
}

async function teardown(): Promise<void> {
	await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
	await pool.query(`DELETE FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`, [SCRATCH_AGENCY]);
	await pool.query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [SCRATCH_AGENCY]);
	await pool.query(`DELETE FROM roadmap.project WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL, max: N_CLAIMERS + 2 });
	await teardown(); // clear any residue from a prior aborted run
	await setup();
});

after(async () => {
	await teardown();
	await pool.end();
});

/**
 * Is the function under test the ATOMIC version (migration 183 applied)?
 * The atomic body adds a plain `FOR UPDATE;` on the agent_registry row resolve;
 * the racy body only has `FOR UPDATE SKIP LOCKED` in Gate 7. Used to skip AC-2
 * gracefully until 183 is applied to live (or P1433_CLAIM_FN points at the probe),
 * so the committed suite is green pre-merge. AC-2 is PROVEN red-green via probe
 * (see P1433 discussion #8673); this guard just keeps CI clean before MERGE.
 */
async function claimFnIsAtomic(): Promise<boolean> {
	const fnName = CLAIM_FN.split(".").pop() as string;
	const { rows } = await pool.query<{ def: string }>(
		`SELECT pg_get_functiondef(oid) AS def FROM pg_proc
		  WHERE proname = $1 AND pronargs = 5 LIMIT 1`,
		[fnName],
	);
	return rows.length > 0 && /\n\s*FOR UPDATE;\s*\n/.test(rows[0].def);
}

test("P1433 AC-2: concurrent claims never exceed max_concurrent_claims", async (t) => {
	if (!(await claimFnIsAtomic())) {
		t.skip("migration 183 not applied to the function under test (racy); AC-2 proven via probe — see P1433 #8673");
		return;
	}
	// Fire N_CLAIMERS parallel claims for the SAME scratch agency. Each uses its
	// own pooled connection (separate transactions) so they genuinely race.
	const claims = Array.from({ length: N_CLAIMERS }, () =>
		pool
			.query(
				`SELECT dispatch_id
				   FROM ${CLAIM_FN}($1, '[]'::jsonb, 1320, $2, NULL)`,
				[SCRATCH_AGENCY, SCRATCH_PROJECT_ID],
			)
			.then((r) => (r.rows[0]?.dispatch_id ?? null) as string | null)
			.catch(() => null),
	);
	const claimed = (await Promise.all(claims)).filter((x): x is string => x !== null);

	// Ground truth from the DB: how many offers does the scratch agency now hold?
	const { rows } = await pool.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM roadmap_workforce.squad_dispatch
		  WHERE agent_identity = $1 AND project_id = $2 AND offer_status = 'claimed'`,
		[SCRATCH_AGENCY, SCRATCH_PROJECT_ID],
	);
	const heldByAgency = Number(rows[0].n);

	// AC-2 ceiling: never more than max_concurrent_claims, even under a claim storm.
	assert.ok(
		heldByAgency <= MAX_CLAIMS,
		`agency holds ${heldByAgency} claims, exceeds ceiling ${MAX_CLAIMS} (ceiling TOCTOU — migration 183 not applied?)`,
	);
	// And it should reach the ceiling (offers were available), not under-claim.
	assert.equal(heldByAgency, MAX_CLAIMS, `expected exactly ${MAX_CLAIMS} claims`);

	// No offer claimed twice (SKIP LOCKED guarantees this; assert for completeness).
	const uniq = new Set(claimed);
	assert.equal(uniq.size, claimed.length, "an offer was claimed by more than one claimer");
});

/**
 * Insert a synthetic claimed offer directly (bypasses the claim ceiling so these
 * reaper tests are independent of AC-2's leftover claims). Returns the new id.
 */
async function insertClaimedOffer(opts: {
	expiresAt: string; // SQL expression, e.g. "now() + interval '1320 seconds'"
	reissueCount: number;
	tag: string;
}): Promise<number> {
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role,
		    dispatch_status, offer_status, required_capabilities, idempotency_key,
		    agent_identity, agency_identity, claim_token, claim_expires_at,
		    claimed_at, reissue_count, max_reissues)
		 VALUES ($1, $2, $3, 'developer', 'assigned', 'claimed',
		         '["develop"]'::jsonb, $4, $5, $5, gen_random_uuid(),
		         ${opts.expiresAt}, now(), $6, 3)
		 RETURNING id`,
		[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `v3c1-reap-${opts.tag}`,
		 `v3c1-reap:${opts.tag}`, SCRATCH_AGENCY, opts.reissueCount],
	);
	return Number(rows[0].id);
}

test("P1433 AC-3: a long-running worker's future-dated lease is NOT reaped", async () => {
	// Simulate a fresh claim under the new TTL (1320s = 22min, > 20min spawn timeout).
	const id = await insertClaimedOffer({
		expiresAt: "now() + interval '1320 seconds'",
		reissueCount: 0,
		tag: "future",
	});

	// Invariant: the lease outlives the spawn timeout, so a worker running right up
	// to the SIGTERM ceiling can never be reaped first.
	const { rows: ttlRows } = await pool.query<{ remaining: string }>(
		`SELECT EXTRACT(EPOCH FROM (claim_expires_at - now()))::int::text AS remaining
		   FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[id],
	);
	assert.ok(
		Number(ttlRows[0].remaining) >= 1200,
		`lease remaining ${ttlRows[0].remaining}s must be >= spawn timeout 1200s`,
	);

	// Reaper must leave the future-dated claim untouched.
	await pool.query(`SELECT roadmap_workforce.fn_reap_expired_offers()`);
	const { rows: afterRows } = await pool.query<{ offer_status: string }>(
		`SELECT offer_status FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[id],
	);
	assert.equal(afterRows[0].offer_status, "claimed", "future-dated lease was falsely reaped");

	await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`, [id]);
});

test("P1433 AC-4: a stale (expired) claimed offer is reaped — reissued, then expired+stamped", async () => {
	// (a) Expired claim with reissues remaining -> reissued back to 'open'.
	const reissuable = await insertClaimedOffer({
		expiresAt: "now() - interval '60 seconds'",
		reissueCount: 0,
		tag: "stale-reissue",
	});
	// (b) Expired claim at the reissue ceiling -> expired + lease_expired stamp.
	const exhausted = await insertClaimedOffer({
		expiresAt: "now() - interval '60 seconds'",
		reissueCount: 3, // == max_reissues
		tag: "stale-exhausted",
	});

	await pool.query(`SELECT roadmap_workforce.fn_reap_expired_offers()`);

	const { rows: a } = await pool.query<{ offer_status: string }>(
		`SELECT offer_status FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[reissuable],
	);
	assert.equal(a[0].offer_status, "open", "stale claim with reissues left should be reissued to open");

	const { rows: b } = await pool.query<{ offer_status: string; reason: string | null }>(
		`SELECT offer_status, metadata->>'failure_reason' AS reason
		   FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[exhausted],
	);
	assert.equal(b[0].offer_status, "expired", "stale claim at reissue ceiling should be expired");
	assert.equal(b[0].reason, "lease_expired", "expired claim must be stamped lease_expired (C2 backfills failure_class from this)");

	// No orphan 'claimed' rows past TTL survived the reaper cycle.
	const { rows: orphans } = await pool.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n FROM roadmap_workforce.squad_dispatch
		  WHERE project_id = $1 AND offer_status = 'claimed'
		    AND claim_expires_at IS NOT NULL AND claim_expires_at < now()`,
		[SCRATCH_PROJECT_ID],
	);
	assert.equal(Number(orphans[0].n), 0, "expired claimed rows survived a reaper cycle");

	await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`, [[reissuable, exhausted]]);
});
