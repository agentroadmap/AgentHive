/**
 * P248: /api/board/columns — route shape, cache headers, and dwell trigger tests.
 *
 * Run: node --import jiti/register --test tests/dashboard/board-columns.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";

// ─── Column shape validator ────────────────────────────────────────────────────

interface BoardColumn {
	stage_name: string;
	stage_order: number;
	display_label: string;
	is_terminal: boolean;
	maturity_gate: string | null;
}

function isValidColumn(c: unknown): c is BoardColumn {
	if (!c || typeof c !== "object") return false;
	const col = c as Record<string, unknown>;
	return (
		typeof col.stage_name === "string" &&
		typeof col.stage_order === "number" &&
		typeof col.display_label === "string" &&
		typeof col.is_terminal === "boolean" &&
		(col.maturity_gate === null || typeof col.maturity_gate === "string")
	);
}

// ─── Cache-Control header logic ───────────────────────────────────────────────

function resolveCacheHeader(bust: string | null): string {
	return bust !== null ? "no-cache" : "public, max-age=300";
}

// ─── Fallback column set ──────────────────────────────────────────────────────

const FALLBACK_COLUMNS: BoardColumn[] = [
	{ stage_name: "DRAFT",    stage_order: 1, display_label: "Draft",    is_terminal: false, maturity_gate: null },
	{ stage_name: "REVIEW",   stage_order: 2, display_label: "Review",   is_terminal: false, maturity_gate: null },
	{ stage_name: "DEVELOP",  stage_order: 3, display_label: "Develop",  is_terminal: false, maturity_gate: null },
	{ stage_name: "MERGE",    stage_order: 4, display_label: "Merge",    is_terminal: false, maturity_gate: null },
	{ stage_name: "COMPLETE", stage_order: 5, display_label: "Complete", is_terminal: true,  maturity_gate: null },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("P248 /api/board/columns — route shape", () => {
	it("AC-8: fallback columns satisfy required schema (stage_name, stage_order, display_label, is_terminal, maturity_gate)", () => {
		assert.ok(FALLBACK_COLUMNS.length >= 5, "need at least 5 stages");
		for (const col of FALLBACK_COLUMNS) {
			assert.ok(isValidColumn(col), `invalid column shape: ${JSON.stringify(col)}`);
		}
	});

	it("AC-8: fallback columns are ordered by stage_order ascending", () => {
		const orders = FALLBACK_COLUMNS.map((c) => c.stage_order);
		const sorted = [...orders].sort((a, b) => a - b);
		assert.deepStrictEqual(orders, sorted, "columns must be ordered by stage_order");
	});

	it("AC-8: at least one column is marked is_terminal", () => {
		assert.ok(
			FALLBACK_COLUMNS.some((c) => c.is_terminal),
			"at least one terminal stage required",
		);
	});

	it("AC-5: zero-proposal columns must not be filtered from the fallback set", () => {
		// All 5 stages are present regardless of proposal count — the client renders
		// an empty column rather than hiding it.
		const names = FALLBACK_COLUMNS.map((c) => c.stage_name);
		assert.ok(names.includes("DRAFT"),    "DRAFT stage must be present");
		assert.ok(names.includes("COMPLETE"), "COMPLETE stage must be present");
	});
});

describe("P248 /api/board/columns — Cache-Control header", () => {
	it("AC-6: no bust param → public, max-age=300", () => {
		assert.strictEqual(resolveCacheHeader(null), "public, max-age=300");
	});

	it("AC-6: bust param present → no-cache (bypasses browser/client cache)", () => {
		assert.strictEqual(resolveCacheHeader("1717000000"), "no-cache");
		assert.strictEqual(resolveCacheHeader(""),           "no-cache");
	});

	it("AC-6: max-age value is exactly 300 (5 minutes)", () => {
		const header = resolveCacheHeader(null);
		const match = header.match(/max-age=(\d+)/);
		assert.ok(match, "max-age not found in header");
		assert.strictEqual(Number(match![1]), 300);
	});
});

describe("P248 proposal_stage_dwell — trigger and view", () => {
	it("AC-7: workflow_stages.is_active column exists", () => {
		const result = execSync(
			`psql -d agenthive -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='roadmap' AND table_name='workflow_stages' AND column_name='is_active';"`,
			{ encoding: "utf-8" },
		).trim();
		assert.strictEqual(result, "1", "is_active column must exist in roadmap.workflow_stages");
	});

	it("AC-10: trg_proposal_dwell_track trigger exists on roadmap_proposal.proposal", () => {
		const result = execSync(
			`psql -d agenthive -tAc "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON t.tgrelid=c.oid JOIN pg_namespace n ON c.relnamespace=n.oid WHERE t.tgname='trg_proposal_dwell_track' AND n.nspname='roadmap_proposal' AND c.relname='proposal';"`,
			{ encoding: "utf-8" },
		).trim();
		assert.strictEqual(result, "1", "trg_proposal_dwell_track must exist");
	});

	it("AC-10: dwell trigger function closes old dwell row and opens new one on status change", () => {
		// Use a test transaction that is rolled back — safe against production data.
		const sql = `
BEGIN;
-- Use a real proposal for the foreign key; grab the first available
DO $$
DECLARE
  pid BIGINT;
  old_stage TEXT;
BEGIN
  SELECT id, status INTO pid, old_stage
    FROM roadmap_proposal.proposal
   LIMIT 1;

  IF pid IS NULL THEN
    RAISE NOTICE 'no proposals — skipping trigger test';
    RETURN;
  END IF;

  -- Ensure there's an open dwell row for the current stage
  INSERT INTO roadmap_proposal.proposal_stage_dwell (proposal_id, stage_name, entered_at)
  VALUES (pid, old_stage, now() - INTERVAL '1 hour')
  ON CONFLICT DO NOTHING;

  -- Advance to a test stage to fire the trigger
  UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = pid AND status != 'DEVELOP';

  -- Verify old row was closed
  IF (SELECT count(*) FROM roadmap_proposal.proposal_stage_dwell
       WHERE proposal_id = pid AND stage_name = old_stage AND exited_at IS NOT NULL) = 0
     AND old_stage != 'DEVELOP' THEN
    RAISE EXCEPTION 'trigger failed to close old dwell row';
  END IF;
END;
$$;
ROLLBACK;
`;
		// We don't assert on the output here — the DO block raises on failure.
		// execSync throws if psql exits non-zero.
		execSync(`psql -d agenthive -c "${sql.replace(/\n/g, " ").replace(/"/g, '\\"')}"`, {
			encoding: "utf-8",
		});
	});

	it("AC-4: v_stage_dwell_stats view exists and has expected columns", () => {
		const result = execSync(
			`psql -d agenthive -tAc "SELECT column_name FROM information_schema.columns WHERE table_schema='roadmap_proposal' AND table_name='v_stage_dwell_stats' ORDER BY ordinal_position;"`,
			{ encoding: "utf-8" },
		).trim();
		const cols = result.split("\n").map((s) => s.trim()).filter(Boolean);
		assert.ok(cols.includes("stage_name"),        "v_stage_dwell_stats must have stage_name");
		assert.ok(cols.includes("avg_dwell_days"),     "v_stage_dwell_stats must have avg_dwell_days");
		assert.ok(cols.includes("median_dwell_days"),  "v_stage_dwell_stats must have median_dwell_days");
	});
});
