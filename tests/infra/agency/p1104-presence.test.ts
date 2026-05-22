/**
 * P1104 Presence State Machine Tests
 *
 * AC-6: presence_state TEXT NOT NULL DEFAULT 'offline' with CHECK (online/busy/away/offline)
 * AC-7: fn_pulse(agency_id, state) atomically updates last_heartbeat_at + presence_state
 * AC-8: pg_notify('agency_presence_changed') fires on state change, not on no-op pulse
 * AC-9: v_agency_status.dispatchable threshold is 60s (not 10 min)
 */

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { Pool } from "pg";
import { query, getPool } from "../../../src/infra/postgres/pool.js";

const SKIP = !process.env.PGPASSWORD && !process.env.DATABASE_URL;
const skip = (name: string, fn: () => Promise<void>) =>
	it(name, async (t) => {
		if (SKIP) { t.skip("DB credentials absent"); return; }
		await fn();
	});

const TEST_AGENCY = "test/p1104-presence";
const TEST_HOST = "hermes";

async function cleanup() {
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [TEST_AGENCY]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [TEST_AGENCY]);
}

async function insertAgency(opts: {
	presence_state?: string;
	status?: string;
	heartbeat_offset?: string;
} = {}) {
	const {
		presence_state = "offline",
		status = "active",
		heartbeat_offset = "0 seconds",
	} = opts;
	await query(
		`INSERT INTO roadmap.agency
		 (agency_id, display_name, provider, host_id, status, presence_state, last_heartbeat_at)
		 VALUES ($1, 'P1104 Test', 'test', $2, $3, $4, now() - $5::interval)`,
		[TEST_AGENCY, TEST_HOST, status, presence_state, heartbeat_offset],
	);
}

describe("P1104: Presence State Machine", { skip: SKIP }, () => {
	before(cleanup);
	afterEach(cleanup);
	after(cleanup);

	// ── AC-6: Column existence and constraints ───────────────────────────────

	describe("AC-6: presence_state column schema", () => {
		skip("column is NOT NULL with default 'offline'", async () => {
			const r = await query(
				`SELECT column_default, is_nullable
				 FROM information_schema.columns
				 WHERE table_schema = 'roadmap' AND table_name = 'agency'
				   AND column_name = 'presence_state'`,
			);
			assert.equal(r.rows.length, 1, "presence_state column missing from roadmap.agency");
			assert.equal(r.rows[0].is_nullable, "NO", "presence_state must be NOT NULL");
			assert(
				r.rows[0].column_default?.includes("offline"),
				`expected default 'offline', got: ${r.rows[0].column_default}`,
			);
		});

		skip("CHECK constraint rejects invalid state values", async () => {
			await insertAgency();
			await assert.rejects(
				() => query(
					`UPDATE roadmap.agency SET presence_state = 'ghost' WHERE agency_id = $1`,
					[TEST_AGENCY],
				),
				(err: any) => /check constraint/i.test(err.message),
			);
		});

		skip("accepts all four valid states", async () => {
			for (const state of ["online", "busy", "away", "offline"]) {
				await insertAgency({ presence_state: "offline" });
				await query(
					`UPDATE roadmap.agency SET presence_state = $1 WHERE agency_id = $2`,
					[state, TEST_AGENCY],
				);
				const r = await query(
					`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
					[TEST_AGENCY],
				);
				assert.equal(r.rows[0].presence_state, state);
				await cleanup();
			}
		});
	});

	// ── AC-7: fn_pulse atomicity ─────────────────────────────────────────────

	describe("AC-7: fn_pulse atomic heartbeat update", () => {
		skip("fn_pulse exists in roadmap schema", async () => {
			const r = await query(
				`SELECT proname FROM pg_proc p
				 JOIN pg_namespace n ON p.pronamespace = n.oid
				 WHERE n.nspname = 'roadmap' AND p.proname = 'fn_pulse'`,
			);
			assert.equal(r.rows.length, 1, "fn_pulse not found in roadmap schema");
		});

		skip("fn_pulse updates last_heartbeat_at and presence_state atomically", async () => {
			await insertAgency({ heartbeat_offset: "60 seconds", presence_state: "offline" });

			const before = await query(
				`SELECT last_heartbeat_at, presence_state FROM roadmap.agency WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			await new Promise((r) => setTimeout(r, 50));
			await query(`SELECT roadmap.fn_pulse($1, $2)`, [TEST_AGENCY, "online"]);

			const after = await query(
				`SELECT last_heartbeat_at, presence_state FROM roadmap.agency WHERE agency_id = $1`,
				[TEST_AGENCY],
			);

			assert(
				after.rows[0].last_heartbeat_at > before.rows[0].last_heartbeat_at,
				"last_heartbeat_at must advance after fn_pulse",
			);
			assert.equal(after.rows[0].presence_state, "online");
		});

		skip("fn_pulse rejects invalid state names", async () => {
			await insertAgency();
			await assert.rejects(
				() => query(`SELECT roadmap.fn_pulse($1, $2)`, [TEST_AGENCY, "invisible"]),
				(err: any) => /invalid presence state/i.test(err.message),
			);
		});

		skip("fn_pulse emits no exception for unknown agency (WARNING only)", async () => {
			await assert.doesNotReject(() =>
				query(`SELECT roadmap.fn_pulse($1, $2)`, ["test/p1104-nonexistent-xyz", "online"]),
			);
		});
	});

	// ── AC-8: pg_notify on state change ──────────────────────────────────────

	describe("AC-8: pg_notify('agency_presence_changed') on state transition", () => {
		skip("emits notification when state changes", async () => {
			await insertAgency({ presence_state: "offline" });

			const pool = getPool();
			const listenClient = await pool.connect();
			try {
				await listenClient.query("LISTEN agency_presence_changed");

				let notified = false;
				let payload: Record<string, unknown> | null = null;
				listenClient.on("notification", (msg) => {
					if (msg.channel === "agency_presence_changed") {
						notified = true;
						payload = JSON.parse(msg.payload ?? "{}");
					}
				});

				// Trigger transition: offline → online
				await query(`SELECT roadmap.fn_pulse($1, $2)`, [TEST_AGENCY, "online"]);

				// AC-8 requires within 1s; wait up to 500ms
				await new Promise((r) => setTimeout(r, 500));

				assert(notified, "agency_presence_changed not received within 500ms");
				assert.equal(payload?.agency_id, TEST_AGENCY);
				assert.equal(payload?.from, "offline");
				assert.equal(payload?.to, "online");
			} finally {
				listenClient.release();
			}
		});

		skip("does NOT emit when state is unchanged (no-op pulse)", async () => {
			await insertAgency({ presence_state: "online" });

			const pool = getPool();
			const listenClient = await pool.connect();
			try {
				await listenClient.query("LISTEN agency_presence_changed");

				let notified = false;
				listenClient.on("notification", (msg) => {
					if (msg.channel === "agency_presence_changed") notified = true;
				});

				// Same state — must not emit
				await query(`SELECT roadmap.fn_pulse($1, $2)`, [TEST_AGENCY, "online"]);
				await new Promise((r) => setTimeout(r, 300));

				assert(!notified, "agency_presence_changed fired on no-op same-state pulse");
			} finally {
				listenClient.release();
			}
		});
	});

	// ── AC-9: dispatchable threshold is 60s ──────────────────────────────────

	describe("AC-9: v_agency_status dispatchable threshold = 60s", () => {
		skip("dispatchable=true when heartbeat is 30s old (within 60s window)", async () => {
			await insertAgency({ heartbeat_offset: "30 seconds", presence_state: "online" });
			const r = await query(
				`SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);
			assert.equal(r.rows[0].dispatchable, true);
		});

		skip("dispatchable=false when heartbeat is 90s old and presence=offline", async () => {
			await insertAgency({ heartbeat_offset: "90 seconds", presence_state: "offline" });
			const r = await query(
				`SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);
			assert.equal(r.rows[0].dispatchable, false, "stale heartbeat + offline presence must not be dispatchable");
		});

		skip("dispatchable=true when presence=online regardless of heartbeat age (canonical signal)", async () => {
			await insertAgency({ heartbeat_offset: "90 seconds", presence_state: "online" });
			const r = await query(
				`SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);
			assert.equal(r.rows[0].dispatchable, true, "presence_state='online' is canonical — overrides stale heartbeat");
		});

		skip("v_agency_status exposes presence_state column", async () => {
			await insertAgency({ presence_state: "busy" });
			const r = await query(
				`SELECT presence_state FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);
			assert.equal(r.rows.length, 1);
			assert.equal(r.rows[0].presence_state, "busy");
		});

		skip("dispatchable=false when status=dormant even with fresh heartbeat", async () => {
			await insertAgency({ status: "dormant", heartbeat_offset: "5 seconds", presence_state: "offline" });
			const r = await query(
				`SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1`,
				[TEST_AGENCY],
			);
			assert.equal(r.rows[0].dispatchable, false, "dormant agencies must never be dispatchable");
		});
	});
});
