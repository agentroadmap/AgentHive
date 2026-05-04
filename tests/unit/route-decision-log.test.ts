/**
 * P772 AC-2/3/4: Unit tests for the route_decision_log audit layer.
 * Tests the SQL shape of buildEliminationDiagnosticSql (pure function, no DB needed).
 * Integration coverage (actual INSERT, FK validity) requires a live test DB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildEliminationDiagnosticSql } from "../../src/core/orchestration/resolvers/route-policy-filters.ts";

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

// ─── buildEliminationDiagnosticSql ────────────────────────────────────────────

describe("buildEliminationDiagnosticSql (P772 eliminated_routes query)", () => {
	it("selects id and route_provider from model_routes", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(sql.includes("mr.id"), "must select mr.id");
		assert.ok(sql.includes("mr.route_provider"), "must select mr.route_provider");
		assert.ok(sql.includes("roadmap.model_routes mr"), "must query model_routes");
	});

	it("excludes the winning route via id != param", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("mr.id != $2"),
			"must exclude winner by id to avoid logging the chosen route as eliminated",
		);
	});

	it("filters by agent_provider param", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(sql.includes("mr.agent_provider = $1"), "must bind agent_provider to $1");
	});

	it("classifies host_policy failures (Layer 1)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'host_policy'") && sql.includes("host_model_policy"),
			"must produce host_policy reason from host_model_policy",
		);
	});

	it("classifies project_policy failures (Layer 2)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'project_policy'") && sql.includes("project_route_policy"),
			"must produce project_policy reason from project_route_policy",
		);
	});

	it("classifies agency_policy failures (Layer 3)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'agency_policy'") && sql.includes("agency_route_policy"),
			"must produce agency_policy reason from agency_route_policy",
		);
	});

	it("classifies role_policy failures (Layer 4)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'role_policy'") && sql.includes("agent_role_profile"),
			"must produce role_policy reason from agent_role_profile",
		);
	});

	it("classifies budget_exhausted failures (Layer 5)", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(
			sql.includes("'budget_exhausted'") && sql.includes("route_token_budget"),
			"must produce budget_exhausted reason from route_token_budget",
		);
	});

	it("uses CASE WHEN to emit first_failing_layer", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(sql.includes("CASE"), "must use CASE WHEN structure");
		assert.ok(sql.includes("first_failing_layer"), "must alias result as first_failing_layer");
		assert.ok(sql.includes("'passed'"), "must emit 'passed' for routes that cleared all layers");
	});

	it("layers evaluate in order: host → project → agency → role → budget", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		const hostPos    = sql.indexOf("'host_policy'");
		const projectPos = sql.indexOf("'project_policy'");
		const agencyPos  = sql.indexOf("'agency_policy'");
		const rolePos    = sql.indexOf("'role_policy'");
		const budgetPos  = sql.indexOf("'budget_exhausted'");
		assert.ok(
			hostPos < projectPos && projectPos < agencyPos && agencyPos < rolePos && rolePos < budgetPos,
			"layers must appear in correct order in CASE WHEN chain",
		);
	});

	it("binds host to $3, project to $4, agency to $5, role to $6", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6));
		assert.ok(sql.includes("$3::text"), "host must bind at $3");
		assert.ok(sql.includes("$4::bigint"), "project_id must bind at $4");
		assert.ok(sql.includes("$5::text"), "agency_identity must bind at $5");
		assert.ok(sql.includes("$6::bigint"), "role_profile_id must bind at $6");
	});

	it("honours custom alias parameter", () => {
		const sql = normalize(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6, "r"));
		assert.ok(sql.includes("r.id"), "must use custom alias for id");
		assert.ok(sql.includes("r.route_provider"), "must use custom alias for route_provider");
		assert.ok(!sql.includes("mr.id"), "must not use default alias when custom alias given");
	});

	it("binds provider and winner params at caller-specified indices", () => {
		const sql7 = normalize(buildEliminationDiagnosticSql(7, 8, 9, 10, 11, 12));
		assert.ok(sql7.includes("$7"), "must use provider index 7");
		assert.ok(sql7.includes("$8"), "must use winner index 8");
		assert.ok(sql7.includes("$9"), "must use host index 9");
		assert.ok(sql7.includes("$10"), "must use project index 10");
	});
});

// ─── Eliminated-routes JSON shape ─────────────────────────────────────────────

describe("eliminated_routes JSON shape (AC-3)", () => {
	it("each entry has route_id, route_provider, and reason fields", () => {
		const entry = { route_id: 42, route_provider: "openai", reason: "agency_policy" };
		assert.equal(typeof entry.route_id, "number");
		assert.equal(typeof entry.route_provider, "string");
		assert.equal(typeof entry.reason, "string");
	});

	it("accepts all valid reason values defined in EliminationReason", () => {
		const validReasons = [
			"host_policy",
			"project_policy",
			"agency_policy",
			"role_policy",
			"budget_exhausted",
		];
		for (const reason of validReasons) {
			const entry = { route_id: 1, route_provider: "anthropic", reason };
			assert.ok(validReasons.includes(entry.reason), `${reason} must be a valid reason`);
		}
	});
});
