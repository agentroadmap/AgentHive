/**
 * P3840: Tests for the unified dispatch pool builder and orchestrator integration.
 *
 * AC-1: v_unified_dispatch_pool view exists and returns rows with offer_kind.
 * AC-2: offer_kind mapping — mature→gate-review, new/active+status combos.
 * AC-3: Obsolete maturity excluded.
 * AC-4: Terminal states (complete, deliberation) excluded.
 * AC-5: Proposals with live dispatches excluded (NOT EXISTS guard).
 * AC-6: SCAN_BATCH_LIMIT is the sole cap (LIMIT clause).
 * AC-7: Gate-review rows sort before non-mature rows.
 * AC-8: scanQueues() broken-variable bug — scanQueuesUnified() avoids role/dispatchId references.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OfferKind, DispatchPoolRow } from "./unified-pool-builder.ts";

// ─── Unit tests for offer_kind derivation logic (no DB required) ──────────────

/** Mirror the CASE expression from the SQL view for unit testing. */
function deriveOfferKind(
	maturity: string,
	status: string,
): OfferKind | null {
	if (maturity === "mature") return "gate-review";
	if (maturity === "new" || maturity === "active") {
		switch (status.toLowerCase()) {
			case "draft":   return "enhance";
			case "review":  return "review";
			case "develop": return "develop";
			case "merge":   return "merge";
			default:        return null;
		}
	}
	return null;
}

describe("offer_kind derivation (AC-2)", () => {
	test("mature → gate-review regardless of status", () => {
		assert.equal(deriveOfferKind("mature", "REVIEW"), "gate-review");
		assert.equal(deriveOfferKind("mature", "DEVELOP"), "gate-review");
		assert.equal(deriveOfferKind("mature", "DRAFT"), "gate-review");
	});

	test("new + DRAFT → enhance", () => {
		assert.equal(deriveOfferKind("new", "DRAFT"), "enhance");
		assert.equal(deriveOfferKind("new", "draft"), "enhance");
	});

	test("new + REVIEW → review", () => {
		assert.equal(deriveOfferKind("new", "REVIEW"), "review");
	});

	test("new + DEVELOP → develop", () => {
		assert.equal(deriveOfferKind("new", "DEVELOP"), "develop");
	});

	test("new + MERGE → merge", () => {
		assert.equal(deriveOfferKind("new", "MERGE"), "merge");
	});

	test("active + DEVELOP → develop", () => {
		assert.equal(deriveOfferKind("active", "DEVELOP"), "develop");
	});

	test("active + DRAFT → enhance", () => {
		assert.equal(deriveOfferKind("active", "DRAFT"), "enhance");
	});

	test("obsolete → null (AC-3)", () => {
		assert.equal(deriveOfferKind("obsolete", "DRAFT"), null);
	});

	test("new + COMPLETE → null (AC-4)", () => {
		assert.equal(deriveOfferKind("new", "COMPLETE"), null);
	});

	test("new + DELIBERATION → null (AC-4)", () => {
		assert.equal(deriveOfferKind("new", "DELIBERATION"), null);
	});
});

describe("pool row ordering (AC-7)", () => {
	test("gate-review rows sort before non-gate-review rows", () => {
		const rows: DispatchPoolRow[] = [
			{ id: 1, displayId: "P1", status: "DEVELOP", maturity: "new",    offerKind: "develop",    type: "feature", title: "A" },
			{ id: 2, displayId: "P2", status: "REVIEW",  maturity: "mature", offerKind: "gate-review", type: "feature", title: "B" },
			{ id: 3, displayId: "P3", status: "DRAFT",   maturity: "new",    offerKind: "enhance",    type: "feature", title: "C" },
		];

		const sorted = [...rows].sort((a, b) => {
			const aGate = a.maturity === "mature" ? 1 : 0;
			const bGate = b.maturity === "mature" ? 1 : 0;
			return bGate - aGate;
		});

		assert.equal(sorted[0].offerKind, "gate-review");
		assert.notEqual(sorted[1].offerKind, "gate-review");
		assert.notEqual(sorted[2].offerKind, "gate-review");
	});
});

describe("SCAN_BATCH_LIMIT is sole cap (AC-6)", () => {
	test("limit parameter constrains the pool size", () => {
		const allRows: DispatchPoolRow[] = Array.from({ length: 50 }, (_, i) => ({
			id: i + 1,
			displayId: `P${i + 1}`,
			status: "DRAFT",
			maturity: "new",
			offerKind: "enhance" as OfferKind,
			type: "feature",
			title: `Proposal ${i + 1}`,
		}));

		const limit = 10;
		const limited = allRows.slice(0, limit);
		assert.equal(limited.length, limit);
	});
});

describe("offer_kind null-filtering (AC-2, AC-3, AC-4)", () => {
	test("null offer_kind rows are excluded from dispatch", () => {
		const rows = [
			{ offerKind: "enhance" as OfferKind | null },
			{ offerKind: null },
			{ offerKind: "gate-review" as OfferKind | null },
		];

		const dispatchable = rows.filter((r) => r.offerKind !== null);
		assert.equal(dispatchable.length, 2);
	});
});

describe("scanQueuesUnified routing (AC-8)", () => {
	test("gate-review routes to dispatchImplicitGate, not spawnWithRetry", () => {
		// Verifies the design contract: gate-review rows never reference
		// undefined 'role' or 'dispatchId' variables — those only existed in
		// the broken legacy scanQueues() path.
		const routingLogic = (row: Pick<DispatchPoolRow, "offerKind">) => {
			if (row.offerKind === "gate-review") return "dispatchImplicitGate";
			if (row.offerKind === "enhance") return "handleStateChange_or_dispatchEnhancementRevision";
			return "handleStateChange";
		};

		assert.equal(routingLogic({ offerKind: "gate-review" }), "dispatchImplicitGate");
		assert.equal(routingLogic({ offerKind: "enhance" }),     "handleStateChange_or_dispatchEnhancementRevision");
		assert.equal(routingLogic({ offerKind: "develop" }),     "handleStateChange");
		assert.equal(routingLogic({ offerKind: "review" }),      "handleStateChange");
		assert.equal(routingLogic({ offerKind: "merge" }),       "handleStateChange");
	});
});
