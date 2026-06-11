/**
 * P2404 Liveness Poke with Cold-Wake Liaisons Tests
 *
 * AC-2 (regression guard): Verify that a timed-out poke NEWER than heartbeat
 *   still shows 'stale-unresponsive', ensuring Part A doesn't blanket-suppress
 *   the real stale signal.
 *
 * AC-3 (live verification): After the view change, an agency with a fresh
 *   heartbeat and older timed-out poke shows a 'live-*' state.
 */

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { query } from "../../../src/infra/postgres/pool.js";

const SKIP = !process.env.PGPASSWORD && !process.env.DATABASE_URL;
const skip = (name: string, fn: () => Promise<void>) =>
	it(name, async (t) => {
		if (SKIP) { t.skip("DB credentials absent"); return; }
		await fn();
	});

const TEST_AGENCY = "test/p2404-liveness-poke";
const TEST_HOST = "hermes";

async function cleanup() {
	await query(`DELETE FROM roadmap_workforce.liaison_poke_attempt WHERE agency_id = $1`, [TEST_AGENCY]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [TEST_AGENCY]);
}

async function insertAgency(opts: {
	status?: string;
	heartbeat_offset?: string;
} = {}) {
	const {
		status = "active",
		heartbeat_offset = "0 seconds",
	} = opts;
	await query(
		`INSERT INTO roadmap.agency
		 (agency_id, display_name, provider, host_id, status, presence_state, last_heartbeat_at)
		 VALUES ($1, 'P2404 Test', 'test', $2, $3, 'online', now() - $4::interval)`,
		[TEST_AGENCY, TEST_HOST, status, heartbeat_offset],
	);
}

async function insertPoke(opts: {
	outcome: string;
	poked_at_offset?: string;  // interval to subtract from now()
} = { outcome: "timed_out" }) {
	const { outcome, poked_at_offset = "0 seconds" } = opts;
	await query(
		`INSERT INTO roadmap_workforce.liaison_poke_attempt
		 (agency_id, outcome, poked_at)
		 VALUES ($1, $2, now() - $3::interval)`,
		[TEST_AGENCY, outcome, poked_at_offset],
	);
}

describe("P2404: Liveness Poke with Cold-Wake Liaisons", { skip: SKIP }, () => {
	before(cleanup);
	afterEach(cleanup);
	after(cleanup);

	// ── AC-2: Regression guard ───────────────────────────────────────────────
	//
	// Ensure that a timed-out poke NEWER than the heartbeat still shows
	// 'stale-unresponsive', proving the fix doesn't blanket-suppress real
	// stale signals.

	describe("AC-2: Regression Guard — fresh timed-out poke still signals stale", () => {
		skip("timed_out poke NEWER than heartbeat shows 'stale-unresponsive'", async () => {
			// Setup: heartbeat 60s ago, poke 10s ago (NEWER than heartbeat)
			await insertAgency({ heartbeat_offset: "60 seconds" });
			await insertPoke({ outcome: "timed_out", poked_at_offset: "10 seconds" });

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows.length,
				1,
				"agency should exist in v_agency_status",
			);
			assert.equal(
				result.rows[0].liveness_state,
				"stale-unresponsive",
				"timed-out poke NEWER than heartbeat must show 'stale-unresponsive' (regression guard)",
			);
		});

		skip("timed_out poke NEWER than heartbeat + heartbeat >60s old shows stale", async () => {
			// Extreme case: heartbeat 120s old, poke 5s ago (definitely NEWER)
			await insertAgency({ heartbeat_offset: "120 seconds" });
			await insertPoke({ outcome: "timed_out", poked_at_offset: "5 seconds" });

			const result = await query(
				`SELECT liveness_state, dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"stale-unresponsive",
				"old heartbeat + fresh timed-out poke must show stale-unresponsive",
			);
			assert.equal(
				result.rows[0].dispatchable,
				false,
				"stale agencies are not dispatchable",
			);
		});

		skip("poke_late (late-pong) NEWER than heartbeat still signals diagnostic state", async () => {
			// Same logic: late-pong poke newer than heartbeat should show 'late-pong'
			await insertAgency({ heartbeat_offset: "70 seconds" });
			await insertPoke({ outcome: "poke_late", poked_at_offset: "10 seconds" });

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"late-pong",
				"poke_late NEWER than heartbeat must show 'late-pong' (same gating)",
			);
		});
	});

	// ── AC-3: Live verification ──────────────────────────────────────────────
	//
	// Verify that a fresh heartbeat OVERRIDES an older timed-out poke,
	// showing 'live-*' instead of 'stale-unresponsive'.

	describe("AC-3: Fresh Heartbeat Overrides Stale Poke", () => {
		skip("fresh heartbeat (10s) + old timed_out poke (40h) shows 'live-but-idle'", async () => {
			// The core fix: heartbeat postdates failed poke
			await insertAgency({ heartbeat_offset: "10 seconds" });
			await insertPoke({ outcome: "timed_out", poked_at_offset: "40 hours" });

			const result = await query(
				`SELECT liveness_state, dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"live-but-idle",
				"fresh heartbeat (10s) postdates old poke (40h) → must show live-but-idle, not stale",
			);
			assert.equal(
				result.rows[0].dispatchable,
				true,
				"fresh heartbeat <60s must be dispatchable",
			);
		});

		skip("sub-second heartbeat overrides any older poke outcome", async () => {
			// Extreme freshness: 0.5s heartbeat (common from cold-wake liaisons)
			await insertAgency({ heartbeat_offset: "0.5 seconds" });
			await insertPoke({ outcome: "timed_out", poked_at_offset: "10 seconds" });

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"live-but-idle",
				"sub-second heartbeat must override even a recent poke timeout",
			);
		});

		skip("no heartbeat + no poke shows 'offline'", async () => {
			// Edge case: no history
			await insertAgency({ heartbeat_offset: "null" });
			// No poke inserted

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"offline",
				"no heartbeat and no poke should show offline",
			);
		});

		skip("no poke at all: heartbeat-only signal works", async () => {
			// Fresh heartbeat, no poke history
			await insertAgency({ heartbeat_offset: "5 seconds" });
			// No poke

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"live-but-idle",
				"fresh heartbeat alone (no poke) should show live-but-idle",
			);
		});
	});

	// ── Edge case: poke_pending ──────────────────────────────────────────────

	describe("Edge case: poke-pending state takes precedence", () => {
		skip("open (pending) poke shows 'poke-pending' regardless of heartbeat", async () => {
			// An open poke (outcome IS NULL) takes priority
			await insertAgency({ heartbeat_offset: "10 seconds" });
			await query(
				`INSERT INTO roadmap_workforce.liaison_poke_attempt
				 (agency_id, outcome, poked_at)
				 VALUES ($1, NULL, now())`,
				[TEST_AGENCY],
			);

			const result = await query(
				`SELECT liveness_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert.equal(
				result.rows[0].liveness_state,
				"poke-pending",
				"open poke (outcome IS NULL) must show poke-pending (highest priority)",
			);
		});
	});
});
