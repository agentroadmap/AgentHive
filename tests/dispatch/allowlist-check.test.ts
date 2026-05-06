import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import { query } from "../../src/postgres/pool.ts";
import {
	evaluateDispatch,
	type EvaluateDispatchArgs,
} from "../../src/shared/dispatch/allowlist-check.ts";

const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === "true";

/**
 * Test setup: Insert test project, routes, capabilities, and budget caps.
 */
async function setupTestProject(): Promise<{
	projectId: number;
	cleanup: () => Promise<void>;
}> {
	if (SKIP_DB_TESTS) {
		return {
			projectId: 999,
			cleanup: async () => {},
		};
	}

	let projectId = 999;

	await query(
		`INSERT INTO roadmap.project (project_id, slug, name, worktree_root, created_at)
		 VALUES ($1, 'test-p484-' || NOW()::text, 'P484 Test Project', '/tmp/p484-test', NOW())
		 ON CONFLICT (project_id) DO NOTHING`,
		[projectId]
	);

	const cleanup = async () => {
		await query(
			`DELETE FROM roadmap.project_route_allowlist WHERE project_id = $1`,
			[projectId]
		);
		await query(
			`DELETE FROM roadmap.project_capability_scope WHERE project_id = $1`,
			[projectId]
		);
		await query(
			`DELETE FROM roadmap.project_budget_cap WHERE project_id = $1`,
			[projectId]
		);
		await query(
			`DELETE FROM roadmap.dispatch_route_audit WHERE project_id = $1`,
			[projectId]
		);
	};

	return { projectId, cleanup };
}

describe("allowlist-check.ts", () => {
	describe("AC-102: Default-DENY route allowlist", () => {
		test("deny route_not_in_allowlist when route row missing", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				// Insert a capability so we can test route denial independently.
				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "nonexistent-route",
					capability_name: "test-cap",
				});

				assert.strictEqual(result.allow, false);
				assert.strictEqual(result.reason, "route_not_in_allowlist");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});

		test("deny capability_not_in_scope when capability row missing", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				// Insert a route so we can test capability denial independently.
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "nonexistent-cap",
				});

				assert.strictEqual(result.allow, false);
				assert.strictEqual(result.reason, "capability_not_in_scope");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});

		test("allow when both route and capability are in allowlist", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
				});

				assert.strictEqual(result.allow, true);
				assert.strictEqual(result.reason, "allowed");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});
	});

	describe("AC-102: Budget enforcement", () => {
		test("deny budget_exceeded when estimated spend exceeds cap", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				// Set up allowlist.
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				// Set a $50 budget cap for the day.
				await query(
					`INSERT INTO roadmap.project_budget_cap
					 (project_id, period, max_usd_cents, created_at)
					 VALUES ($1, 'day', $2, NOW())`,
					[projectId, 5000]
				);

				// Try to dispatch with $100 estimated spend (should fail).
				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					estimated_usd_cents: 10000,
				});

				assert.strictEqual(result.allow, false);
				assert.strictEqual(result.reason, "budget_exceeded");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});

		test("allow when estimated spend is within budget cap", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				// Set a $100 budget cap for the day.
				await query(
					`INSERT INTO roadmap.project_budget_cap
					 (project_id, period, max_usd_cents, created_at)
					 VALUES ($1, 'day', $2, NOW())`,
					[projectId, 10000]
				);

				// Try to dispatch with $50 estimated spend (should succeed).
				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					estimated_usd_cents: 5000,
				});

				assert.strictEqual(result.allow, true);
				assert.strictEqual(result.reason, "allowed");
				assert.ok(result.remaining_budget_cents !== undefined);
			} finally {
				await cleanup();
			}
		});
	});

	describe("AC-2: Agency capability intersection", () => {
		test("deny when capability not in agency_capabilities list", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				// Set up allowlist.
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				// Agency has access to different-cap, not test-cap.
				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					agency_capabilities: ["different-cap", "another-cap"],
				});

				assert.strictEqual(result.allow, false);
				assert.strictEqual(result.reason, "capability_not_in_agency_scope");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});

		test("allow when capability is in agency_capabilities list", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				// Agency has access to test-cap.
				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					agency_capabilities: ["test-cap", "other-cap"],
				});

				assert.strictEqual(result.allow, true);
				assert.strictEqual(result.reason, "allowed");
				assert.ok(result.audit_id);
			} finally {
				await cleanup();
			}
		});
	});

	describe("AC-103: Compliance hook (stubbed)", () => {
		test("compliance hook is pass-through (always allows if other checks pass)", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				const result = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
				});

				assert.strictEqual(result.allow, true);
				assert.strictEqual(result.reason, "allowed");
			} finally {
				await cleanup();
			}
		});
	});

	describe("AC-101: Atomicity and race condition prevention", () => {
		test("SELECT...FOR UPDATE pattern is used in checkBudgetAtomic", () => {
			const sourceFile =
				"src/shared/dispatch/allowlist-check.ts";
			const importModule = require("../../src/shared/dispatch/allowlist-check.ts");

			assert.ok(importModule, `Module ${sourceFile} should be importable`);

			const fs = require("node:fs");
			const source = fs.readFileSync(sourceFile, "utf8");

			assert.ok(
				source.includes("FOR UPDATE"),
				"Source should use SELECT...FOR UPDATE for atomic locking"
			);
		});

		test("zero-cap blocks any dispatch; within-cap allows", async () => {
			if (SKIP_DB_TESTS) {
				return;
			}

			const { projectId, cleanup } = await setupTestProject();

			try {
				await query(
					`INSERT INTO roadmap.project_route_allowlist
					 (project_id, route_name, created_at)
					 VALUES ($1, 'test-route', NOW())`,
					[projectId]
				);

				await query(
					`INSERT INTO roadmap.project_capability_scope
					 (project_id, capability_name, created_at)
					 VALUES ($1, 'test-cap', NOW())`,
					[projectId]
				);

				// Set $0 cap — any estimate should deny.
				await query(
					`INSERT INTO roadmap.project_budget_cap
					 (project_id, period, max_usd_cents, created_at)
					 VALUES ($1, 'day', 0, NOW())`,
					[projectId]
				);

				const denied = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					estimated_usd_cents: 1,
				});
				assert.strictEqual(denied.allow, false, "Any spend against $0 cap should deny");
				assert.strictEqual(denied.reason, "budget_exceeded");

				// Raise cap to $100 — same estimate should now allow.
				await query(
					`UPDATE roadmap.project_budget_cap
					 SET max_usd_cents = 10000
					 WHERE project_id = $1 AND period = 'day'`,
					[projectId]
				);

				const allowed = await evaluateDispatch({
					project_id: projectId,
					route_name: "test-route",
					capability_name: "test-cap",
					estimated_usd_cents: 1,
				});
				assert.strictEqual(allowed.allow, true, "Dispatch within cap should be allowed");
			} finally {
				await cleanup();
			}
		});
	});
});
