/**
 * P934 — Integration test for fn_lease_clear_maturity_on_release.
 *
 * Covers AC-4 (deterministic mapping, no fall-through), AC-5 (obsolete
 * + terminal invariants preserved), AC-6 (trigger writes audit event),
 * AC-10 (P931 regression test).
 *
 * Each test isolates state via BEGIN/ROLLBACK so the database is left
 * untouched. Requires a live agenthive DB connection via PG* env or
 * DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

let proposalId: number | null = null;
let leaseId: number | null = null;

async function withTx<T>(fn: (tx: import("pg").PoolClient) => Promise<T>): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		try {
			return await fn(client);
		} finally {
			// Always rollback, even on throw, so the connection isn't returned
			// to the pool with an aborted transaction (which would poison the
			// next caller's BEGIN).
			await client.query("ROLLBACK").catch(() => undefined);
		}
	} finally {
		client.release();
	}
}

let sandboxCounter = 0;

before(async () => {
	const pool = getPool();
	await pool.query("SELECT 1"); // smoke check
	// proposal_lease.agent_identity has a FK to agent_registry; ensure
	// the test agent exists. ON CONFLICT DO NOTHING keeps it idempotent
	// across repeated runs.
	await pool.query(
		`INSERT INTO roadmap_workforce.agent_registry
			(agent_identity, agent_type, trust_tier, status)
		 VALUES ('test/p934', 'tool', 'restricted', 'active')
		 ON CONFLICT (agent_identity) DO NOTHING`,
	);
});

after(async () => {
	await closePool();
});

/**
 * Helper: create a sandbox proposal + lease with the desired pre-release
 * maturity. Order matters because trg_lease_set_maturity_active forces
 * maturity='active' on lease INSERT, so the test must set the desired
 * pre-release maturity AFTER the lease exists.
 */
async function setupSandbox(
	tx: import("pg").PoolClient,
	preReleaseMaturity: string,
): Promise<{ pid: number; lid: number }> {
	// Unique display_id per call avoids the unique-constraint collision
	// when previous test rollbacks haven't cleared the conflict (or when
	// running tests in parallel).
	const displayId = `PSANDBOX-${process.pid}-${++sandboxCounter}`;
	const { rows: pRows } = await tx.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
			(display_id, type, status, maturity, title, summary, audit)
		 VALUES ($1, 'feature', 'DRAFT', 'new', 't', 's', '[]'::jsonb)
		 RETURNING id`,
		[displayId],
	);
	const pid = pRows[0].id;
	const { rows: lRows } = await tx.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal_lease
			(proposal_id, agent_identity, expires_at)
		 VALUES ($1, 'test/p934', now() + interval '5 minutes') RETURNING id`,
		[pid],
	);
	const lid = lRows[0].id;
	// Override the lease-INSERT-trigger's auto-set 'active' to whatever
	// the test scenario needs. Reset audit so MaturityChange entries from
	// this UPDATE don't pollute the assertions.
	await tx.query(
		`UPDATE roadmap_proposal.proposal SET maturity = $1, audit = '[]'::jsonb WHERE id = $2`,
		[preReleaseMaturity, pid],
	);
	return { pid, lid };
}

test("P934 AC-4: authored_complete preserves mature (P931 regression)", async () => {
	await withTx(async (tx) => {
		const { pid, lid } = await setupSandbox(tx, "mature");

		await tx.query(
			`UPDATE roadmap_proposal.proposal_lease
			    SET released_at = now(), release_reason = 'authored_complete'
			  WHERE id = $1`,
			[lid],
		);

		const { rows } = await tx.query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].maturity, "mature", "authored_complete must preserve mature");
	});
});

test("P934 AC-4: manual_release demotes to new + AC-6 audit event written", async () => {
	await withTx(async (tx) => {
		const { pid, lid } = await setupSandbox(tx, "mature");

		await tx.query(
			`UPDATE roadmap_proposal.proposal_lease
			    SET released_at = now(), release_reason = 'manual_release'
			  WHERE id = $1`,
			[lid],
		);

		const { rows } = await tx.query<{ maturity: string; audit: unknown[] }>(
			`SELECT maturity, audit FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].maturity, "new", "manual_release must demote mature → new");

		// AC-6: trigger must have written a MaturityChange audit entry.
		const audit = rows[0].audit as Array<Record<string, unknown>>;
		const matEntry = audit.find(
			(e) =>
				e.Activity === "MaturityChange" && e.Agent === "lease_release_trigger",
		);
		assert.ok(matEntry, "trigger must write MaturityChange audit entry");
		assert.equal(matEntry.From, "mature");
		assert.equal(matEntry.To, "new");
		assert.equal(matEntry.release_reason, "manual_release");
		// bigint encoded as string in JSON; coerce for comparison.
		assert.equal(String(matEntry.lease_id), String(lid));
	});
});

test("P934 AC-4: wont_pursue → obsolete", async () => {
	await withTx(async (tx) => {
		const { pid, lid } = await setupSandbox(tx, "active");

		await tx.query(
			`UPDATE roadmap_proposal.proposal_lease
			    SET released_at = now(), release_reason = 'wont_pursue'
			  WHERE id = $1`,
			[lid],
		);

		const { rows } = await tx.query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].maturity, "obsolete");
	});
});

test("P934 AC-5: obsolete preservation (trigger never overwrites obsolete)", async () => {
	await withTx(async (tx) => {
		const { pid, lid } = await setupSandbox(tx, "obsolete");

		// Even with 'work_delivered' (would normally → mature), obsolete must stick.
		await tx.query(
			`UPDATE roadmap_proposal.proposal_lease
			    SET released_at = now(), release_reason = 'work_delivered'
			  WHERE id = $1`,
			[lid],
		);

		const { rows } = await tx.query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].maturity, "obsolete", "obsolete must never be overwritten");
	});
});

test("P934 AC-4: unknown release_reason RAISES (no silent demotion)", async () => {
	await withTx(async (tx) => {
		const { lid } = await setupSandbox(tx, "mature");

		await assert.rejects(
			tx.query(
				`UPDATE roadmap_proposal.proposal_lease
				    SET released_at = now(), release_reason = 'released'
				  WHERE id = $1`,
				[lid],
			),
			(err: Error) => /P934.*Unknown release_reason/.test(err.message),
		);
		// The test wrapper rolls back the whole tx; no further verification needed.
	});
});

test("P934 AC-11: gate_transitioned keeps maturity at new (auto-release path)", async () => {
	await withTx(async (tx) => {
		const { pid, lid } = await setupSandbox(tx, "mature");

		await tx.query(
			`UPDATE roadmap_proposal.proposal_lease
			    SET released_at = now(), release_reason = 'gate_transitioned'
			  WHERE id = $1`,
			[lid],
		);

		const { rows } = await tx.query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[pid],
		);
		assert.equal(rows[0].maturity, "new", "gate_transitioned → new for next stage");
	});
});
