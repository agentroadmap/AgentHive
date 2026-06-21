/**
 * P3847 AC-3/4/5/6: Unit tests for the silent-spawn watchdog.
 *
 * All tests use a mock Pool (no real DB) and an injectable incrementFailureFn.
 * The mock pool tracks every query call in-order so we can assert the exact
 * SQL operations without relying on a live database.
 *
 * AC-3: Silent run → reaped (status=timeout, error_detail set, lease released)
 * AC-4: Progressing run → NOT reaped (negative: scan returns no rows)
 * AC-5: incrementFailureFn called for the agency after reaping
 * AC-6: Observability alert upserted to agency_observability_alert_state
 */

import { describe, it, expect, mock } from "bun:test";
import { detectAndReapSilentSpawns } from "../silent-spawn-watchdog.ts";
import type { SilentWatchdogOptions } from "../silent-spawn-watchdog.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = { log: () => {}, warn: () => {} };

interface MockQuery {
	sql: string;
	params: unknown[];
}

/**
 * Build a mock pg.Pool that returns controlled rows for the first query (scan)
 * and an empty result for all subsequent queries (UPDATE / INSERT).
 * Records every query call for assertion.
 */
function makePool(scanRows: unknown[] = []) {
	const calls: MockQuery[] = [];
	let callCount = 0;

	const query = mock(async (sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		callCount++;
		// First call is the scan — return controlled rows.
		if (callCount === 1) {
			return { rows: scanRows, rowCount: scanRows.length };
		}
		// Subsequent calls are UPDATE/INSERT — return empty.
		return { rows: [], rowCount: 1 };
	});

	return { query: query as unknown as typeof import("pg").Pool.prototype.query, calls };
}

/** Build an injectable incrementFailureFn spy. */
function makeIncrementSpy() {
	return mock(async (_identity: string, _threshold: number, _cls: "timeout") => {});
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SILENT_ROW = {
	id: "run-abc-123",
	agency_identity: "claude-bot-gary.a",
	proposal_id: "3847",
};

const SILENT_ROW_NO_AGENCY = {
	id: "run-xyz-456",
	agency_identity: null,
	proposal_id: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("P3847 silent-spawn watchdog", () => {
	// ── AC-3: Silent run is reaped ──────────────────────────────────────────

	describe("AC-3: silent run reaped", () => {
		it("returns silentSpawnsTimedOut=1 when scan finds a silent row", async () => {
			const { query, calls } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			const result = await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(result.silentSpawnsTimedOut).toBe(1);
			// Scan + UPDATE agent_run + UPDATE lease + observability upsert
			expect(calls.length).toBeGreaterThanOrEqual(4);
		});

		it("marks the agent_run status=timeout with P3847 error_detail", async () => {
			const { query, calls } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			// Second call is the agent_run UPDATE
			const agentRunUpdate = calls.find(
				(c) =>
					c.sql.includes("agent_runs") &&
					c.sql.includes("status = 'timeout'") &&
					c.sql.includes("error_detail"),
			);
			expect(agentRunUpdate).toBeDefined();
			expect(agentRunUpdate?.params[0]).toBe(SILENT_ROW.id);
		});

		it("releases the proposal_lease for the reaped run", async () => {
			const { query, calls } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			const leaseRelease = calls.find(
				(c) =>
					c.sql.includes("proposal_lease") &&
					c.sql.includes("released_at") &&
					c.sql.includes("silent_spawn_timeout"),
			);
			expect(leaseRelease).toBeDefined();
			// Params: proposal_id, agency_identity
			expect(leaseRelease?.params).toContain(SILENT_ROW.proposal_id);
			expect(leaseRelease?.params).toContain(SILENT_ROW.agency_identity);
		});

		it("returns 0 when scan finds no rows", async () => {
			const { query } = makePool([]);
			const incrementSpy = makeIncrementSpy();

			const result = await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(result.silentSpawnsTimedOut).toBe(0);
			expect(incrementSpy).not.toHaveBeenCalled();
		});
	});

	// ── AC-4: Progressing run is NOT reaped ────────────────────────────────

	describe("AC-4: progressing run not reaped", () => {
		it("does not reap when scan returns empty (SQL excluded progressing runs)", async () => {
			// The real SQL guards on tool_call_log activity; in unit tests we model
			// this by having the scan return no rows — the same outcome the DB produces
			// when all running rows have recent tool calls against their briefing.
			const { query, calls } = makePool([]);
			const incrementSpy = makeIncrementSpy();

			const result = await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(result.silentSpawnsTimedOut).toBe(0);
			// Only the scan query was made — no UPDATE calls
			expect(calls.length).toBe(1);
			expect(calls[0].sql).toContain("tool_call_log");
		});

		it("scan SQL excludes runs that have tool_call_log rows after started_at", () => {
			// White-box: verify the scan query contains the NOT EXISTS tool_call_log guard
			// so that a progressing run (briefing_id IS NOT NULL AND has tool calls)
			// is structurally excluded from the result set.
			const { query, calls } = makePool([]);
			const _ = detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
			);
			// Give the query a tick to emit
			return _.then(() => {
				const scanSql = calls[0]?.sql ?? "";
				expect(scanSql).toContain("NOT EXISTS");
				expect(scanSql).toContain("tool_call_log");
				expect(scanSql).toContain("briefing_id");
			});
		});
	});

	// ── AC-5: Repeated-failure throttle ────────────────────────────────────

	describe("AC-5: spawn-failure throttle counter incremented", () => {
		it("calls incrementFailureFn with the agency identity", async () => {
			const { query } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(incrementSpy).toHaveBeenCalledTimes(1);
			expect(incrementSpy).toHaveBeenCalledWith(
				SILENT_ROW.agency_identity,
				3,
				"timeout",
			);
		});

		it("does not call incrementFailureFn when agency_identity is null", async () => {
			const { query } = makePool([SILENT_ROW_NO_AGENCY]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(incrementSpy).not.toHaveBeenCalled();
		});

		it("calls incrementFailureFn once per reaped row with multiple silent runs", async () => {
			const ROW_B = { ...SILENT_ROW, id: "run-bbb-222", agency_identity: "codex-bot-gary.a" };
			const { query } = makePool([SILENT_ROW, ROW_B]);
			const incrementSpy = makeIncrementSpy();

			const result = await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			expect(result.silentSpawnsTimedOut).toBe(2);
			expect(incrementSpy).toHaveBeenCalledTimes(2);
		});
	});

	// ── AC-6: Observability alert surface ──────────────────────────────────

	describe("AC-6: observability alert upserted", () => {
		it("upserts a silent_spawn_timeout alert to agency_observability_alert_state", async () => {
			const { query, calls } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			const alertUpsert = calls.find(
				(c) =>
					c.sql.includes("agency_observability_alert_state") &&
					c.sql.includes("silent_spawn_timeout"),
			);
			expect(alertUpsert).toBeDefined();
			expect(alertUpsert?.params[0]).toBe(
				`silent_spawn_timeout:${SILENT_ROW.agency_identity}`,
			);
			expect(alertUpsert?.params[1]).toBe(SILENT_ROW.agency_identity);
		});

		it("does not upsert alert when agency_identity is null", async () => {
			const { query, calls } = makePool([SILENT_ROW_NO_AGENCY]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			const alertUpsert = calls.find((c) =>
				c.sql.includes("agency_observability_alert_state"),
			);
			expect(alertUpsert).toBeUndefined();
		});

		it("alert metadata includes agent_run_id, proposal_id, and threshold_ms", async () => {
			const { query, calls } = makePool([SILENT_ROW]);
			const incrementSpy = makeIncrementSpy();

			await detectAndReapSilentSpawns(
				{ query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			const alertUpsert = calls.find((c) =>
				c.sql.includes("agency_observability_alert_state"),
			);
			const metadata = JSON.parse(alertUpsert?.params[2] as string ?? "{}");
			expect(metadata.agent_run_id).toBe(SILENT_ROW.id);
			expect(metadata.proposal_id).toBe(SILENT_ROW.proposal_id);
			expect(typeof metadata.threshold_ms).toBe("number");
			expect(metadata.threshold_ms).toBeGreaterThan(0);
		});
	});

	// ── Error containment ──────────────────────────────────────────────────

	describe("error containment", () => {
		it("returns 0 and warns (no throw) when the scan query fails", async () => {
			const warnMessages: string[] = [];
			const logger = {
				log: () => {},
				warn: (msg: string) => warnMessages.push(msg),
			};
			const pool = {
				query: mock(async () => {
					throw new Error("connection refused");
				}),
			} as unknown as import("pg").Pool;

			const result = await detectAndReapSilentSpawns(pool, logger, "Test");

			expect(result.silentSpawnsTimedOut).toBe(0);
			expect(warnMessages.some((m) => m.includes("silent-run scan failed"))).toBe(true);
		});

		it("counts partial success when one row reap fails mid-loop", async () => {
			// Scan returns 2 rows; the agent_run UPDATE for run-1 throws (lock timeout),
			// triggering the outer catch; run-2's UPDATE succeeds → silentSpawnsTimedOut=1.
			const warnMessages: string[] = [];
			const logger = {
				log: () => {},
				warn: (msg: string) => warnMessages.push(msg),
			};
			let agentRunUpdateCount = 0;
			const ROW_B = { ...SILENT_ROW, id: "run-bbb-222" };
			const pool = {
				query: mock(async (sql: string, _params?: unknown[]) => {
					// Scan: SELECT from agent_runs (no SET clause)
					if (sql.includes("agent_runs") && !sql.includes("SET status")) {
						return { rows: [SILENT_ROW, ROW_B], rowCount: 2 };
					}
					// agent_run UPDATE: fail on the first run, succeed on the second
					if (sql.includes("agent_runs") && sql.includes("SET status")) {
						agentRunUpdateCount++;
						if (agentRunUpdateCount === 1) throw new Error("lock timeout");
						return { rows: [], rowCount: 1 };
					}
					return { rows: [], rowCount: 1 };
				}),
			} as unknown as import("pg").Pool;

			const result = await detectAndReapSilentSpawns(
				pool,
				logger,
				"Test",
				{ incrementFailureFn: makeIncrementSpy() },
			);

			// run-1 failed in outer try → 0 reaped from it; run-2 succeeded → 1 reaped
			expect(result.silentSpawnsTimedOut).toBe(1);
			expect(warnMessages.some((m) => m.includes("failed to reap"))).toBe(true);
		});

		it("skips side-effects when agent_run UPDATE returns rowCount=0 (already reaped by no-progress-watchdog)", async () => {
			// N-ORCH-1: if no-progress-watchdog already flipped the row to timeout,
			// the UPDATE returns rowCount=0 and we must skip throttle + alert to prevent
			// double-increment and double-alert.
			const incrementSpy = makeIncrementSpy();
			const pool = {
				query: mock(async (sql: string) => {
					if (sql.includes("agent_runs") && !sql.includes("SET status")) {
						return { rows: [SILENT_ROW], rowCount: 1 };
					}
					// agent_run UPDATE: simulate already-reaped (rowCount=0)
					if (sql.includes("agent_runs") && sql.includes("SET status")) {
						return { rows: [], rowCount: 0 };
					}
					return { rows: [], rowCount: 1 };
				}),
			} as unknown as import("pg").Pool;

			const result = await detectAndReapSilentSpawns(
				{ query: pool.query } as unknown as import("pg").Pool,
				noopLogger,
				"Test",
				{ incrementFailureFn: incrementSpy },
			);

			// Row was already reaped — should not count it or call throttle/alert
			expect(result.silentSpawnsTimedOut).toBe(0);
			expect(incrementSpy).not.toHaveBeenCalled();
		});
	});
});
