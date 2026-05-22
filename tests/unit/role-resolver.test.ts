import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getRolesForQueue } from "../../src/core/orchestration/role-resolver.ts";

describe("role-resolver", () => {
	test("returns the DB-backed D4 gate-reviewer profile before fallback merge roles", async () => {
		const roles = await getRolesForQueue(
			{
				workflowTemplateId: 14,
				stage: "MERGE",
				maturity: "mature",
				projectId: null,
			},
			async () => ({
				rows: [
					{
						id: 1,
						role: "gate-reviewer",
						required_capabilities: [
							"gating",
							"review",
							"devops",
							"ops",
							"qa",
							"e2e-testing",
							"regression-testing",
						],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: {
							mode: "d4_merge_gate",
						},
						priority: 5,
					},
					{
						id: 2,
						role: "reviewer-d4",
						required_capabilities: [],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
				],
			}),
		);

		assert.equal(roles[0]?.role, "gate-reviewer");
		assert.equal(roles[0]?.source, "db");
		assert.deepEqual(roles[0]?.requiredCapabilities, [
			"gating",
			"review",
			"devops",
			"ops",
			"qa",
			"e2e-testing",
			"regression-testing",
		]);
		assert.equal(roles[1]?.role, "reviewer-d4");
	});
});
