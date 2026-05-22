import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agencyPolicyFilterSql } from "../../src/core/orchestration/resolvers/route-policy-filters.ts";

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

describe("agencyPolicyFilterSql", () => {
	it("resolves the agency by identity before checking policy rows", () => {
		const sql = normalize(agencyPolicyFilterSql(4));
		assert.ok(sql.includes("FROM agency.agency a"), "must read agency.agency");
		assert.ok(
			sql.includes("a.agency_id = $4::text"),
			"must bind agency identity by param",
		);
	});

	it("matches policy rows by route id, not provider arrays", () => {
		const sql = normalize(agencyPolicyFilterSql(4));
		assert.ok(sql.includes("arp.route_id = mr.id"), "must match the candidate route id");
		assert.ok(!sql.includes("allowed_route_providers"), "must not use legacy allow arrays");
		assert.ok(!sql.includes("forbidden_route_providers"), "must not use legacy deny arrays");
	});

	it("implements open-by-default plus explicit deny semantics", () => {
		const sql = normalize(agencyPolicyFilterSql(4));
		assert.ok(sql.includes("NOT EXISTS"), "must open-pass when policy rows are absent");
		assert.ok(sql.includes("arp.allowed = true"), "must admit explicit allow rows");
		assert.ok(sql.includes("arp.allowed = false"), "must reject explicit deny rows");
	});

	it("only considers global active policy rows", () => {
		const sql = normalize(agencyPolicyFilterSql(4));
		assert.ok(sql.includes("arp.scope = 'global'"), "must filter to global scope");
		assert.ok(
			sql.includes("arp.lifecycle_status = 'active'"),
			"must filter to active policy rows",
		);
	});
});
