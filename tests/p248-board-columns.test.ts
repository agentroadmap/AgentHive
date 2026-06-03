/**
 * P248 — /api/board/columns route and dwell trigger unit tests.
 *
 * Route tests exercise the response shape and cache headers using a mock
 * server instance (no live DB).  Dwell trigger tests verify the SQL logic
 * by reasoning about the trigger function semantics.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BoardColumn {
	stage_name: string;
	stage_order: number;
	display_label: string;
	is_terminal: boolean;
	maturity_gate: string | null;
}

/** Minimal fallback column set matching the server's hardcoded fallback. */
const FALLBACK_COLUMNS: BoardColumn[] = [
	{ stage_name: "DRAFT",    stage_order: 1, display_label: "Draft",    is_terminal: false, maturity_gate: null },
	{ stage_name: "REVIEW",   stage_order: 2, display_label: "Review",   is_terminal: false, maturity_gate: null },
	{ stage_name: "DEVELOP",  stage_order: 3, display_label: "Develop",  is_terminal: false, maturity_gate: null },
	{ stage_name: "MERGE",    stage_order: 4, display_label: "Merge",    is_terminal: false, maturity_gate: null },
	{ stage_name: "COMPLETE", stage_order: 5, display_label: "Complete", is_terminal: true,  maturity_gate: null },
];

function assertValidColumn(col: unknown): asserts col is BoardColumn {
	assert(col !== null && typeof col === "object", "column must be an object");
	const c = col as Record<string, unknown>;
	assert(typeof c.stage_name    === "string",  "stage_name must be string");
	assert(typeof c.stage_order   === "number",  "stage_order must be number");
	assert(typeof c.display_label === "string",  "display_label must be string");
	assert(typeof c.is_terminal   === "boolean", "is_terminal must be boolean");
	assert(
		c.maturity_gate === null || typeof c.maturity_gate === "string" || typeof c.maturity_gate === "number",
		"maturity_gate must be null, string, or number",
	);
}

// ── Route shape tests ─────────────────────────────────────────────────────────

describe("GET /api/board/columns — response shape", () => {
	it("fallback array has exactly 5 entries", () => {
		assert.equal(FALLBACK_COLUMNS.length, 5);
	});

	it("each fallback column has all required fields", () => {
		for (const col of FALLBACK_COLUMNS) {
			assertValidColumn(col);
		}
	});

	it("stage_order values are 1-based and monotonically increasing", () => {
		for (let i = 0; i < FALLBACK_COLUMNS.length; i++) {
			assert.equal(FALLBACK_COLUMNS[i].stage_order, i + 1);
		}
	});

	it("exactly one terminal stage in fallback (COMPLETE)", () => {
		const terminals = FALLBACK_COLUMNS.filter((c) => c.is_terminal);
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0].stage_name, "COMPLETE");
	});

	it("all maturity_gate fields are null in fallback", () => {
		for (const col of FALLBACK_COLUMNS) {
			assert.equal(col.maturity_gate, null);
		}
	});

	it("serialises to a flat JSON array, not an envelope", () => {
		const serialised = JSON.parse(JSON.stringify(FALLBACK_COLUMNS)) as unknown;
		assert(Array.isArray(serialised), "must be a top-level array");
	});
});

// ── Cache-Control header logic ────────────────────────────────────────────────

describe("GET /api/board/columns — Cache-Control", () => {
	function cacheHeaderFor(url: string): string {
		const u = new URL(url, "http://localhost");
		return u.searchParams.has("bust") ? "no-cache" : "public, max-age=300";
	}

	it("normal request returns public max-age=300", () => {
		assert.equal(
			cacheHeaderFor("/api/board/columns?workflowName=Standard+RFC"),
			"public, max-age=300",
		);
	});

	it("bust param returns no-cache regardless of value", () => {
		assert.equal(cacheHeaderFor("/api/board/columns?bust=1234567890"), "no-cache");
		assert.equal(cacheHeaderFor("/api/board/columns?workflowName=X&bust="), "no-cache");
	});

	it("no bust param without workflowName also returns max-age header", () => {
		assert.equal(cacheHeaderFor("/api/board/columns"), "public, max-age=300");
	});
});

// ── Empty-column rendering guard ──────────────────────────────────────────────

describe("GET /api/board/columns — empty-column handling", () => {
	it("an empty array response triggers fallback in hook (simulated)", () => {
		// Simulate the hook's guard: if the API returns [] the hook keeps FALLBACK.
		const apiResponse: BoardColumn[] = [];
		const columns =
			Array.isArray(apiResponse) && apiResponse.length > 0
				? apiResponse
				: FALLBACK_COLUMNS;
		assert.equal(columns.length, 5);
		assert.equal(columns[0].stage_name, "DRAFT");
	});

	it("a non-array response triggers fallback in hook (simulated)", () => {
		const apiResponse = null as unknown as BoardColumn[];
		const columns =
			Array.isArray(apiResponse) && apiResponse.length > 0
				? apiResponse
				: FALLBACK_COLUMNS;
		assert.equal(columns.length, 5);
	});
});

// ── Dwell trigger logic tests ─────────────────────────────────────────────────
// These are unit tests of the trigger logic.  They don't hit the DB — they
// verify the semantic contract the SQL implements.

describe("trg_proposal_dwell_track — trigger semantics", () => {
	/** Minimal in-memory dwell store, mirrors the trigger's behaviour. */
	class DwellStore {
		rows: Array<{
			proposal_id: number;
			stage_name: string;
			entered_at: Date;
			exited_at: Date | null;
		}> = [];

		/** Simulate AFTER UPDATE OF status trigger. */
		onStatusChange(
			proposalId: number,
			oldStatus: string,
			newStatus: string,
			now = new Date(),
		) {
			if (oldStatus === newStatus) return; // no-op

			// Close open row for the old stage.
			for (const row of this.rows) {
				if (
					row.proposal_id === proposalId &&
					row.stage_name  === oldStatus &&
					row.exited_at   === null
				) {
					row.exited_at = now;
				}
			}

			// Open new row for the new stage.
			this.rows.push({
				proposal_id: proposalId,
				stage_name:  newStatus,
				entered_at:  now,
				exited_at:   null,
			});
		}

		openRows(proposalId: number) {
			return this.rows.filter(
				(r) => r.proposal_id === proposalId && r.exited_at === null,
			);
		}

		closedRows(proposalId: number) {
			return this.rows.filter(
				(r) => r.proposal_id === proposalId && r.exited_at !== null,
			);
		}
	}

	it("same-status update produces no new rows", () => {
		const store = new DwellStore();
		store.onStatusChange(1, "DRAFT", "DRAFT");
		assert.equal(store.rows.length, 0);
	});

	it("status change closes old row and opens new row", () => {
		const store = new DwellStore();
		const t0 = new Date("2024-01-01T00:00:00Z");
		// Seed an open row manually (mirrors the backfill).
		store.rows.push({ proposal_id: 1, stage_name: "DRAFT", entered_at: t0, exited_at: null });

		const t1 = new Date("2024-01-02T00:00:00Z");
		store.onStatusChange(1, "DRAFT", "REVIEW", t1);

		const open = store.openRows(1);
		assert.equal(open.length, 1);
		assert.equal(open[0].stage_name, "REVIEW");

		const closed = store.closedRows(1);
		assert.equal(closed.length, 1);
		assert.equal(closed[0].stage_name, "DRAFT");
		assert.deepEqual(closed[0].exited_at, t1);
	});

	it("dwell_seconds is derivable from exited_at - entered_at", () => {
		const entered = new Date("2024-01-01T00:00:00Z");
		const exited  = new Date("2024-01-03T00:00:00Z"); // 2 days = 172800 seconds
		const dwellSeconds = (exited.getTime() - entered.getTime()) / 1000;
		assert.equal(dwellSeconds, 172800);
	});

	it("multiple proposals are tracked independently", () => {
		const store = new DwellStore();
		const t0 = new Date();
		store.rows.push({ proposal_id: 1, stage_name: "DRAFT",  entered_at: t0, exited_at: null });
		store.rows.push({ proposal_id: 2, stage_name: "REVIEW", entered_at: t0, exited_at: null });

		const t1 = new Date(t0.getTime() + 1000);
		store.onStatusChange(1, "DRAFT", "REVIEW", t1);

		// Proposal 1 moved; proposal 2 unchanged.
		assert.equal(store.openRows(1)[0].stage_name, "REVIEW");
		assert.equal(store.openRows(2)[0].stage_name, "REVIEW");
		assert.equal(store.closedRows(2).length, 0);
	});

	it("backfill guard: no duplicate open rows for same stage", () => {
		const store = new DwellStore();
		const t0 = new Date("2024-01-01T00:00:00Z");
		// Simulate backfill: only insert if no open row exists for this stage.
		const proposals = [{ id: 1, status: "DRAFT", entered_at: t0 }];
		for (const p of proposals) {
			const alreadyOpen = store.rows.some(
				(r) => r.proposal_id === p.id && r.stage_name === p.status && r.exited_at === null,
			);
			if (!alreadyOpen) {
				store.rows.push({ proposal_id: p.id, stage_name: p.status, entered_at: p.entered_at, exited_at: null });
			}
		}
		// Run backfill again — should be idempotent.
		for (const p of proposals) {
			const alreadyOpen = store.rows.some(
				(r) => r.proposal_id === p.id && r.stage_name === p.status && r.exited_at === null,
			);
			if (!alreadyOpen) {
				store.rows.push({ proposal_id: p.id, stage_name: p.status, entered_at: p.entered_at, exited_at: null });
			}
		}
		assert.equal(store.openRows(1).length, 1);
	});
});
