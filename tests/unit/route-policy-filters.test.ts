/**
 * P771 AC-2: Unit tests for the 4 pure SQL filter fragment helpers.
 * Each helper is tested in isolation — no DB connection required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	agencyPolicyFilterSql,
	budgetFilterSql,
	projectPolicyFilterSql,
	rolePolicyFilterSql,
} from "../../src/core/orchestration/resolvers/route-policy-filters.ts";

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

// ─── Layer 2: project_route_policy ───────────────────────────────────────────

describe("projectPolicyFilterSql (Layer 2)", () => {
	it("includes null-skip clause so a null project_id passes all routes", () => {
		const sql = normalize(projectPolicyFilterSql(4));
		assert.ok(
			sql.includes("$4::bigint IS NULL"),
			"must short-circuit when param is NULL",
		);
	});

	it("skips filter when no project_route_policy row exists", () => {
		const sql = normalize(projectPolicyFilterSql(4));
		assert.ok(
			sql.includes("OR NOT EXISTS") && sql.includes("project_route_policy"),
			"must open-pass when no policy row present",
		);
	});

	it("checks allowed_route_providers allowlist", () => {
		const sql = normalize(projectPolicyFilterSql(4));
		assert.ok(
			sql.includes("allowed_route_providers"),
			"must reference allowed_route_providers",
		);
		assert.ok(
			sql.includes("route_provider = ANY(pp.allowed_route_providers)"),
			"must check route_provider against allowlist",
		);
	});

	it("checks forbidden_route_providers denylist", () => {
		const sql = normalize(projectPolicyFilterSql(4));
		assert.ok(
			sql.includes(
				"NOT (mr.route_provider = ANY(COALESCE(pp.forbidden_route_providers",
			),
			"must exclude forbidden providers",
		);
	});

	it("honours custom alias parameter", () => {
		const sql = normalize(projectPolicyFilterSql(2, "r"));
		assert.ok(sql.includes("r.route_provider"), "must use custom alias");
		assert.ok(!sql.includes("mr.route_provider"), "must not use default alias");
	});

	it("binds to the correct param index", () => {
		const sql7 = normalize(projectPolicyFilterSql(7));
		assert.ok(sql7.includes("$7::bigint"), "must use param index 7");
		const sql2 = normalize(projectPolicyFilterSql(2));
		assert.ok(sql2.includes("$2::bigint"), "must use param index 2");
	});
});

// ─── Layer 3: agency_route_policy ────────────────────────────────────────────

describe("agencyPolicyFilterSql (Layer 3)", () => {
	it("includes null-skip clause for null agency identity", () => {
		const sql = normalize(agencyPolicyFilterSql(5));
		assert.ok(
			sql.includes("$5::text IS NULL"),
			"must short-circuit when param is NULL",
		);
	});

	it("skips filter when the agency identity does not resolve or has no active policy rows", () => {
		const sql = normalize(agencyPolicyFilterSql(5));
		assert.ok(
			sql.includes("FROM roadmap.agency a") &&
				sql.includes("a.agency_id = $5::text"),
			"must resolve the agency by identity",
		);
		assert.ok(
			sql.includes("NOT EXISTS") && sql.includes("roadmap.agency_route_policy"),
			"must open-pass when no active policy row is present",
		);
	});

	it("allows routes with an active allowed=true row", () => {
		const sql = normalize(agencyPolicyFilterSql(5));
		assert.ok(
			sql.includes("arp.route_id = mr.id"),
			"must match the policy row to the candidate route id",
		);
		assert.ok(
			sql.includes("arp.allowed = true"),
			"must permit explicit allow rows",
		);
	});

	it("excludes routes with an active allowed=false row", () => {
		const sql = normalize(agencyPolicyFilterSql(5));
		assert.ok(
			sql.includes("arp.allowed = false"),
			"must exclude explicit deny rows",
		);
	});

	it("filters only global active policy rows", () => {
		const sql = normalize(agencyPolicyFilterSql(5));
		assert.ok(
			sql.includes("arp.scope = 'global'"),
			"must restrict to global scope rows",
		);
		assert.ok(
			sql.includes("arp.lifecycle_status = 'active'"),
			"must ignore non-active policy rows",
		);
	});

	it("binds to the correct param index", () => {
		const sql = normalize(agencyPolicyFilterSql(3));
		assert.ok(sql.includes("$3::text"), "must use param index 3");
	});
});

// ─── Layer 4: agent_role_profile ─────────────────────────────────────────────

describe("rolePolicyFilterSql (Layer 4)", () => {
	it("includes null-skip clause for null role profile id", () => {
		const sql = normalize(rolePolicyFilterSql(6));
		assert.ok(
			sql.includes("$6::bigint IS NULL"),
			"must short-circuit when param is NULL",
		);
	});

	it("skips filter when no agent_role_profile row exists", () => {
		const sql = normalize(rolePolicyFilterSql(6));
		assert.ok(
			sql.includes("OR NOT EXISTS") && sql.includes("agent_role_profile"),
			"must open-pass when no profile row present",
		);
	});

	it("checks allowed_route_providers with IS NULL open-pass", () => {
		const sql = normalize(rolePolicyFilterSql(6));
		assert.ok(
			sql.includes("rp.allowed_route_providers IS NULL"),
			"null allowed list means all routes pass",
		);
	});

	it("checks forbidden_route_providers with IS NULL open-pass", () => {
		const sql = normalize(rolePolicyFilterSql(6));
		assert.ok(
			sql.includes("rp.forbidden_route_providers IS NULL"),
			"null forbidden list means nothing excluded",
		);
	});

	it("binds to the correct param index", () => {
		const sql = normalize(rolePolicyFilterSql(9));
		assert.ok(sql.includes("$9::bigint"), "must use param index 9");
	});
});

// ─── Layer 5: route_token_budget ─────────────────────────────────────────────

describe("budgetFilterSql (Layer 5)", () => {
	it("includes null-skip clause for null project id", () => {
		const sql = normalize(budgetFilterSql(4));
		assert.ok(
			sql.includes("$4::bigint IS NULL"),
			"must short-circuit when param is NULL",
		);
	});

	it("references route_token_budget table", () => {
		const sql = normalize(budgetFilterSql(4));
		assert.ok(
			sql.includes("route_token_budget"),
			"must query route_token_budget",
		);
	});

	it("uses hour_window = date_trunc('hour', NOW())", () => {
		const sql = normalize(budgetFilterSql(4));
		assert.ok(
			sql.includes("date_trunc('hour', NOW())"),
			"must scope budget check to current hour",
		);
	});

	it("only excludes routes where tokens_consumed >= max_tokens", () => {
		const sql = normalize(budgetFilterSql(4));
		assert.ok(
			sql.includes("tokens_consumed >= rtb.max_tokens"),
			"must exclude only fully-depleted routes",
		);
		assert.ok(
			sql.includes("rtb.max_tokens IS NOT NULL"),
			"must skip routes with no budget cap set",
		);
	});

	it("joins on route_provider for route-level budget tracking", () => {
		const sql = normalize(budgetFilterSql(4));
		assert.ok(
			sql.includes("rtb.route_provider = mr.route_provider") ||
				(sql.includes("rtb.route_provider =") &&
					sql.includes("route_provider")),
			"must filter by route_provider",
		);
	});

	it("binds project_id to the correct param index", () => {
		const sql = normalize(budgetFilterSql(3));
		assert.ok(
			sql.includes("rtb.project_id = $3::bigint") || sql.includes("$3::bigint"),
			"must use param index 3",
		);
	});
});
