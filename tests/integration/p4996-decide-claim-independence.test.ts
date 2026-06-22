/**
 * P4996 (V3.1-S1): builder≠decider independence as a CLAIM-TIME invariant +
 * `decide` offer-kind.
 *
 * Live behavioral proof (gated by AGENTHIVE_ALLOW_LIVE_DB=1, host port 5432) that:
 *   (a) a BUILDER agency claiming a `decide` offer is REJECTED (flag ON, multi-agency);
 *   (b) an INDEPENDENT agency claiming the same offer is ACCEPTED;
 *   (c) the SINGLE-AGENCY degraded path ALLOWS the claim + records the floor advisory;
 *   (d) with the flag OFF, behavior is UNCHANGED (builder claim succeeds — P1433 parity).
 *
 * Fixture pattern mirrors p1438-self-claim-e2e.test.ts: a dedicated scratch project
 * the live orchestrator is NOT subscribed to, scratch agencies + a scratch proposal,
 * full teardown even on failure. The migration-318 functions are applied
 * idempotently in before() (CREATE OR REPLACE, behavior-neutral with the flag OFF);
 * the flag is toggled per-test and forced OFF in teardown so global state is never
 * left ON.
 *
 * Red-green: if Gate 6b is missing, test (a) would ACCEPT the builder's claim and
 * fail its assertion; if the single-agency floor were a hard block, test (c) would
 * get NULL and fail; if the flag gate leaked, test (d) would reject and fail.
 */

import { test, before, after } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
	__dirname,
	"../../scripts/migrations/318-p4996-decide-offer-claim-independence.sql",
);

const SCRATCH_PROJECT_ID = 994996;
const SCRATCH_SLUG = "p4996-claim-indep";
const FK_PROPOSAL_ID = 4996; // P4996 itself — used only for the proposal_id FK
const BUILDER_AGENCY = "p4996-builder-agency";
const OTHER_BUILDER_AGENCY = "p4996-other-builder-agency";
const INDEP_AGENCY = "p4996-independent-agency";
const SOLE_BUILDER_AGENCY = "p4996-sole-builder-agency";
const FLAG = "AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED";

let pool: Pool;

async function setFlag(on: boolean): Promise<void> {
	await pool.query(
		`UPDATE core.runtime_flag SET value_jsonb = $2::jsonb
		  WHERE flag_name = $1 AND scope = 'global'`,
		[FLAG, on ? "true" : "false"],
	);
}

async function seedAgency(name: string): Promise<number> {
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, max_concurrent_claims, project_id)
		 VALUES ($1, 'agency', 'active', 5, $2)
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET status = 'active', max_concurrent_claims = 5, project_id = $2
		 RETURNING id`,
		[name, SCRATCH_PROJECT_ID],
	);
	await pool.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, status, is_active, capabilities)
		 VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
		 ON CONFLICT DO NOTHING`,
		[rows[0].id, name, SCRATCH_PROJECT_ID],
	);
	return rows[0].id;
}

/**
 * Record a build-role dispatch so `name` becomes a builder of FK_PROPOSAL_ID.
 * The builder resolver keys on (dispatch_role, agency_identity) only — status is
 * irrelevant — so we leave the row 'open'/'open' to satisfy all NOT-NULL/claimed
 * check constraints. The 'open' candidate would never be picked because its
 * dispatch_role ('developer') doesn't match the decide capability filter, and we
 * teardown before any flag-OFF claim test that could pick it.
 */
async function seedBuildRoleDispatch(name: string): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role, agency_identity,
		    dispatch_status, offer_status, required_capabilities, idempotency_key)
		 VALUES ($1, $2, $3, 'developer', $4, 'completed', 'failed',
		         '["develop"]'::jsonb, $5)`,
		[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `p4996-build-${name}`, name, `p4996-build:${name}`],
	);
}

/**
 * Seed an OPEN decide offer; returns its dispatch id.
 * worker_identity is pre-populated with an already-registered agency so the claim
 * UPDATE (which does not set worker_identity) satisfies BOTH the
 * sd_worker_identity_claimed_not_null check AND the worker_identity FK to
 * agent_registry on the claimed row.
 */
async function seedDecideOffer(tag: string, workerIdentity: string): Promise<number> {
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role,
		    dispatch_status, offer_status, required_capabilities, worker_identity, idempotency_key)
		 VALUES ($1, $2, $3, 'gate_decision_agent', 'open', 'open',
		         '["gate_review"]'::jsonb, $5, $4)
		 RETURNING id`,
		[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `p4996-decide-${tag}`, `p4996-decide:${tag}`, workerIdentity],
	);
	return rows[0].id;
}

async function claim(agency: string): Promise<{
	dispatch_id: number | null;
	proposal_id: number | null;
}> {
	const { rows } = await pool.query(
		`SELECT dispatch_id, proposal_id
		   FROM roadmap_workforce.fn_claim_work_offer($1, '[]'::jsonb, 60, $2, NULL)`,
		[agency, SCRATCH_PROJECT_ID],
	);
	if (rows.length === 0) return { dispatch_id: null, proposal_id: null };
	return { dispatch_id: rows[0].dispatch_id, proposal_id: rows[0].proposal_id };
}

async function teardown(): Promise<void> {
	try {
		await setFlag(false); // never leave the flag ON globally
		await pool.query(`DELETE FROM control_audit.claim_rejection WHERE agency_id IN (
			SELECT id FROM roadmap_workforce.agent_registry WHERE project_id = $1)`,
			[SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap_workforce.provider_registry WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap_workforce.agent_registry WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap.project WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
	} catch (e) {
		console.error("teardown error (continuing):", e instanceof Error ? e.message : e);
	}
}

before(async () => {
	if (!LIVE) return;
	pool = new Pool({ connectionString: DB_URL, max: 10 });

	// Apply migration-318 functions idempotently (CREATE OR REPLACE; behavior-
	// neutral with the flag OFF). The migration file is its own transaction.
	const sql = readFileSync(MIGRATION_PATH, "utf8");
	await pool.query(sql);

	await teardown(); // clear residue
	await pool.query(
		`INSERT INTO roadmap.project
		   (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1, $2, $2, '/tmp/p4996', 'active', 'bot', 0, 'live')
		 ON CONFLICT (project_id) DO UPDATE SET status = 'active'`,
		[SCRATCH_PROJECT_ID, SCRATCH_SLUG],
	);
});

after(async () => {
	if (!LIVE) return;
	await teardown();
	await pool.end();
});

test("P4996 (a) flag ON, multi-agency: BUILDER agency is REJECTED from a decide offer", { skip: !LIVE }, async () => {
	await teardown();
	await pool.query(
		`INSERT INTO roadmap.project (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1,$2,$2,'/tmp/p4996','active','bot',0,'live') ON CONFLICT (project_id) DO UPDATE SET status='active'`,
		[SCRATCH_PROJECT_ID, SCRATCH_SLUG]);
	await seedAgency(BUILDER_AGENCY);
	await seedAgency(OTHER_BUILDER_AGENCY);
	// TWO distinct builder agencies → multi-agency (not the single-agency floor).
	await seedBuildRoleDispatch(BUILDER_AGENCY);
	await seedBuildRoleDispatch(OTHER_BUILDER_AGENCY);
	const offerId = await seedDecideOffer("a", BUILDER_AGENCY);
	await setFlag(true);

	const result = await claim(BUILDER_AGENCY);
	assert.strictEqual(
		result.dispatch_id,
		null,
		"builder agency must NOT be able to claim the decide offer when flag is ON",
	);

	// Offer must remain OPEN for an independent agency.
	const { rows } = await pool.query(
		`SELECT offer_status FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[offerId],
	);
	assert.strictEqual(rows[0].offer_status, "open", "decide offer must remain open after a refused builder claim");

	// A rejection audit row must have been recorded.
	const rej = await pool.query(
		`SELECT reason_class FROM control_audit.claim_rejection
		  WHERE reason_class = 'GATE_INDEPENDENCE_VIOLATION'
		    AND reason_detail LIKE '%' || $1 || '%'`,
		[BUILDER_AGENCY],
	);
	assert.ok(rej.rows.length >= 1, "a GATE_INDEPENDENCE_VIOLATION audit row must be recorded");
});

test("P4996 (b) flag ON: INDEPENDENT agency is ACCEPTED for the decide offer", { skip: !LIVE }, async () => {
	await teardown();
	await pool.query(
		`INSERT INTO roadmap.project (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1,$2,$2,'/tmp/p4996','active','bot',0,'live') ON CONFLICT (project_id) DO UPDATE SET status='active'`,
		[SCRATCH_PROJECT_ID, SCRATCH_SLUG]);
	await seedAgency(BUILDER_AGENCY);
	await seedAgency(OTHER_BUILDER_AGENCY);
	await seedAgency(INDEP_AGENCY);
	await seedBuildRoleDispatch(BUILDER_AGENCY);
	await seedBuildRoleDispatch(OTHER_BUILDER_AGENCY);
	const offerId = await seedDecideOffer("b", BUILDER_AGENCY);
	await setFlag(true);

	const result = await claim(INDEP_AGENCY);
	assert.strictEqual(result.dispatch_id, offerId, "independent agency must claim the decide offer");

	const { rows } = await pool.query(
		`SELECT offer_status, agency_identity FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[offerId],
	);
	assert.strictEqual(rows[0].offer_status, "claimed");
	assert.strictEqual(rows[0].agency_identity, INDEP_AGENCY);
});

test("P4996 (c) flag ON, single-agency floor: SOLE builder is ALLOWED + advisory recorded", { skip: !LIVE }, async () => {
	await teardown();
	await pool.query(
		`INSERT INTO roadmap.project (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1,$2,$2,'/tmp/p4996','active','bot',0,'live') ON CONFLICT (project_id) DO UPDATE SET status='active'`,
		[SCRATCH_PROJECT_ID, SCRATCH_SLUG]);
	await seedAgency(SOLE_BUILDER_AGENCY);
	// EXACTLY ONE builder agency → single-agency floor.
	await seedBuildRoleDispatch(SOLE_BUILDER_AGENCY);
	const offerId = await seedDecideOffer("c", SOLE_BUILDER_AGENCY);
	await setFlag(true);

	const result = await claim(SOLE_BUILDER_AGENCY);
	assert.strictEqual(
		result.dispatch_id,
		offerId,
		"sole builder agency must be ALLOWED under the single-agency floor (no deadlock)",
	);

	const advisory = await pool.query(
		`SELECT reason_class FROM control_audit.claim_rejection
		  WHERE reason_class = 'GATE_INDEPENDENCE_SINGLE_AGENCY_FLOOR'
		    AND dispatch_id = $1`,
		[offerId],
	);
	assert.ok(advisory.rows.length >= 1, "single-agency floor advisory must be recorded");
});

test("P4996 (d) flag OFF: BUILDER agency claim SUCCEEDS (P1433 parity, behavior unchanged)", { skip: !LIVE }, async () => {
	await teardown();
	await pool.query(
		`INSERT INTO roadmap.project (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1,$2,$2,'/tmp/p4996','active','bot',0,'live') ON CONFLICT (project_id) DO UPDATE SET status='active'`,
		[SCRATCH_PROJECT_ID, SCRATCH_SLUG]);
	await seedAgency(BUILDER_AGENCY);
	await seedAgency(OTHER_BUILDER_AGENCY);
	await seedBuildRoleDispatch(BUILDER_AGENCY);
	await seedBuildRoleDispatch(OTHER_BUILDER_AGENCY);
	const offerId = await seedDecideOffer("d", BUILDER_AGENCY);
	await setFlag(false); // explicitly OFF

	const result = await claim(BUILDER_AGENCY);
	assert.strictEqual(
		result.dispatch_id,
		offerId,
		"with the flag OFF a builder agency claims the decide offer exactly as in P1433",
	);
});
