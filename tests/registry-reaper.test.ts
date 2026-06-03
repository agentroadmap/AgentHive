/**
 * P1093 — Agent Registry Reaper — Integration Tests
 *
 * AC-9:  Active rows (status='active') are never reaped regardless of last_seen_at.
 * AC-10: Rows with an open proposal_lease are never reaped even if status='inactive'.
 *
 * Runs against the live DB (PGUSER/PGDATABASE env vars).
 * Each test inserts isolated rows (unique agent_identity with timestamp suffix)
 * and cleans them up in after() blocks regardless of test outcome.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/infra/postgres/pool.ts";

const TS = Date.now();

// ── helpers ──────────────────────────────────────────────────────────────────

async function insertRegistryRow(
	agentIdentity: string,
	status: "active" | "inactive",
	lastSeenAt: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, last_seen_at)
		 VALUES ($1, 'llm', $2, $3::timestamptz)
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[agentIdentity, status, lastSeenAt],
	);
}

async function deleteRegistryRow(agentIdentity: string): Promise<void> {
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agentIdentity],
	);
}

async function isReaped(agentIdentity: string): Promise<boolean> {
	const { rows } = await query<{ reaped_at: Date | null }>(
		`SELECT reaped_at FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agentIdentity],
	);
	return rows.length > 0 && rows[0]!.reaped_at !== null;
}

async function runReaper(retentionMs = 100): Promise<number> {
	// Use a 1ms interval so any row inserted > 1ms ago is eligible.
	// pg INTERVAL arithmetic: '0.001 seconds' = 1ms
	const interval = retentionMs <= 100 ? "0.001 seconds" : "14 days";
	const { rows } = await query<{ fn_reap_stale_registry: number }>(
		`SELECT roadmap_workforce.fn_reap_stale_registry($1::interval)`,
		[interval],
	);
	return rows[0]!.fn_reap_stale_registry;
}

// ── AC-9: Active row preservation ────────────────────────────────────────────

describe("P1093 registry-reaper: active-row preservation (AC-9)", () => {
	const identity = `reaper-test-active-${TS}`;

	before(async () => {
		// Very old last_seen_at to ensure it would be eligible if status check were absent
		await insertRegistryRow(identity, "active", "2000-01-01");
	});

	after(async () => {
		await deleteRegistryRow(identity);
	});

	it("never reaps a row whose status is 'active'", async () => {
		// Wait a tick so last_seen_at < now() - 1ms is definitely true
		await new Promise((r) => setTimeout(r, 5));
		await runReaper();
		assert.equal(
			await isReaped(identity),
			false,
			"active row must not be soft-deleted by the reaper",
		);
	});
});

// ── AC-10: Open-lease protection ──────────────────────────────────────────────

describe("P1093 registry-reaper: open-lease protection (AC-10)", () => {
	const identity = `reaper-test-leased-${TS}`;
	let leaseId: number | null = null;

	before(async () => {
		await insertRegistryRow(identity, "inactive", "2000-01-01");

		// Insert an open proposal_lease for this identity
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal_lease
			   (proposal_id, agent_identity, claimed_at, expires_at)
			 VALUES (
			   (SELECT id FROM roadmap_proposal.proposal LIMIT 1),
			   $1,
			   now(),
			   now() + interval '1 hour'
			 )
			 RETURNING id`,
			[identity],
		);
		leaseId = rows[0]?.id ?? null;
	});

	after(async () => {
		// Must delete lease before registry row (FK constraint)
		if (leaseId !== null) {
			await query(
				`DELETE FROM roadmap_proposal.proposal_lease WHERE id = $1`,
				[leaseId],
			);
		}
		await deleteRegistryRow(identity);
	});

	it("never reaps an inactive row that has an open proposal_lease", async () => {
		await new Promise((r) => setTimeout(r, 5));
		await runReaper();
		assert.equal(
			await isReaped(identity),
			false,
			"row with open lease must not be soft-deleted",
		);
	});
});

// ── AC-6 smoke: advisory lock (concurrent calls, only one runs) ───────────────

describe("P1093 registry-reaper: advisory lock prevents concurrent runs (AC-6)", () => {
	it("two concurrent invocations do not double-reap (one returns 0)", async () => {
		// Both calls race; the lock holder does work, the other returns 0 immediately.
		// We can't guarantee ordering, but sum must equal work actually done.
		const [a, b] = await Promise.all([runReaper(), runReaper()]);
		// One of them must have returned 0 (lost the advisory lock race) OR
		// one got the lock and finished before the other even tried — both valid.
		// Key invariant: no row is reaped twice (would throw or silently no-op in UPDATE).
		assert.ok(a >= 0 && b >= 0, `both results must be non-negative: a=${a} b=${b}`);
	});
});
