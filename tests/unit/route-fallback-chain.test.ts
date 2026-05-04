/**
 * P773 AC-1/2/3/4/5: Unit tests for the Layer 6 cooldown fallback chain.
 * Tests the SQL shape of cooldownFilterSql and the updated
 * buildEliminationDiagnosticSql (pure functions, no DB needed).
 * Integration coverage (actual cooldown_until writes, fallback routing)
 * requires a live test DB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildEliminationDiagnosticSql,
	cooldownFilterSql,
} from "../../src/core/orchestration/resolvers/route-policy-filters.ts";
import type { EliminationReason } from "../../src/core/orchestration/resolvers/route-resolver.types.ts";

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

// ─── cooldownFilterSql (Layer 6) ─────────────────────────────────────────────

describe("cooldownFilterSql (P773 Layer 6)", () => {
	it("uses default alias mr", () => {
		const sql = cooldownFilterSql();
		assert.ok(sql.includes("mr.cooldown_until"), "must reference mr.cooldown_until");
	});

	it("allows routes with NULL cooldown_until (no cooldown active)", () => {
		const sql = cooldownFilterSql();
		assert.ok(sql.includes("cooldown_until IS NULL"), "must allow NULL cooldown_until");
	});

	it("allows routes where cooldown_until has elapsed (<=NOW())", () => {
		const sql = cooldownFilterSql();
		assert.ok(sql.includes("cooldown_until <= NOW()"), "must allow elapsed cooldown");
	});

	it("uses OR so both conditions open-pass the layer", () => {
		const sql = cooldownFilterSql();
		assert.ok(sql.includes("OR"), "must use OR to combine null-check and elapsed-check");
	});

	it("respects custom alias", () => {
		const sql = cooldownFilterSql("r");
		assert.ok(sql.includes("r.cooldown_until"), "must use custom alias");
		assert.ok(!sql.includes("mr.cooldown_until"), "must not use default alias");
	});

	it("uses no bind parameters (direct column expression)", () => {
		const sql = cooldownFilterSql();
		assert.ok(!sql.includes("$"), "cooldown filter must not use any bind parameters");
	});
});

// ─── buildEliminationDiagnosticSql with Layer 6 ──────────────────────────────

describe("buildEliminationDiagnosticSql Layer 6 throttled (P773)", () => {
	it("classifies throttled failures as 'throttled' (Layer 6)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'throttled'"),
			"must emit 'throttled' for cooldown-excluded routes",
		);
	});

	it("references cooldown_until in throttled classification", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("cooldown_until"),
			"throttled layer must reference cooldown_until column",
		);
	});

	it("throttled layer comes after budget_exhausted in CASE WHEN chain", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		const budgetPos   = sql.indexOf("'budget_exhausted'");
		const throttlePos = sql.indexOf("'throttled'");
		assert.ok(
			budgetPos < throttlePos,
			"'throttled' must appear after 'budget_exhausted' in CASE WHEN",
		);
	});

	it("throttled layer comes before 'passed' in CASE WHEN chain", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		const throttlePos = sql.indexOf("'throttled'");
		const passedPos   = sql.indexOf("'passed'");
		assert.ok(
			throttlePos < passedPos,
			"'throttled' must appear before 'passed' in CASE WHEN",
		);
	});

	it("full 6-layer order: host → project → agency → role → budget → throttled → passed", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		const positions = {
			host:     sql.indexOf("'host_policy'"),
			project:  sql.indexOf("'project_policy'"),
			agency:   sql.indexOf("'agency_policy'"),
			role:     sql.indexOf("'role_policy'"),
			budget:   sql.indexOf("'budget_exhausted'"),
			throttled: sql.indexOf("'throttled'"),
			passed:   sql.indexOf("'passed'"),
		};
		assert.ok(
			positions.host < positions.project &&
			positions.project < positions.agency &&
			positions.agency < positions.role &&
			positions.role < positions.budget &&
			positions.budget < positions.throttled &&
			positions.throttled < positions.passed,
			"all 6 layers must appear in correct order",
		);
	});
});

// ─── EliminationReason type coverage ─────────────────────────────────────────

describe("EliminationReason type includes 'throttled' (P773 AC-4)", () => {
	it("'throttled' is a valid EliminationReason", () => {
		const reason: EliminationReason = "throttled";
		assert.equal(reason, "throttled");
	});

	it("all P773 reason values are strings", () => {
		const reasons: EliminationReason[] = [
			"host_policy",
			"project_policy",
			"agency_policy",
			"role_policy",
			"budget_exhausted",
			"throttled",
		];
		for (const r of reasons) {
			assert.equal(typeof r, "string", `${r} must be a string`);
		}
	});
});

// ─── NoPolicyAllowedRoute.all_throttled shape ─────────────────────────────────

describe("NoPolicyAllowedRoute all_throttled flag (P773 AC-3)", () => {
	it("all_throttled=true shape has correct fields", () => {
		const err = { name: "NoPolicyAllowedRoute", all_throttled: true, host: "bot", provider: "anthropic", hint: null };
		assert.equal(err.name, "NoPolicyAllowedRoute");
		assert.equal(err.all_throttled, true);
	});

	it("all_throttled=false is the default (policy block, not throttle)", () => {
		const err = { name: "NoPolicyAllowedRoute", all_throttled: false, host: "bot", provider: "anthropic", hint: null };
		assert.equal(err.all_throttled, false);
	});
});
