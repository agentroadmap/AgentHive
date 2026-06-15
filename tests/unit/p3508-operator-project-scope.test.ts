/**
 * P3508: Multi-project operator token scoping tests.
 *
 * AC-7: A token with scoped_project_id=P denies calls targeting project Q≠P,
 *       and writes a failure_reason='project scope: ...' row to operator_audit_log.
 * AC-4: A token with scoped_project_id=NULL allows calls regardless of targetProjectId
 *       (full scope, no lockout regression).
 *
 * Requires AGENTHIVE_ALLOW_LIVE_DB=1 because it writes operator_token rows.
 * All test rows are deleted in afterEach.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { query } from "../../src/infra/postgres/pool.ts";
import { authorizeOperatorByToken } from "../../src/apps/server/operator-auth.ts";

const describeLive =
	process.env.AGENTHIVE_ALLOW_LIVE_DB === "1" ? describe : describe.skip;

describeLive("P3508: operator project scope enforcement", () => {
	let fullScopeRaw: string;
	let scopedRaw: string;
	let tokenIds: number[] = [];

	// Insert a test operator_token row, returns its id
	async function insertToken(opts: {
		raw: string;
		allowed_actions: string[];
		scoped_project_id: number | null;
	}): Promise<number> {
		const sha = crypto
			.createHash("sha256")
			.update(opts.raw)
			.digest("hex");
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap.operator_token
			   (operator_name, token_sha256, allowed_actions, scoped_project_id)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id`,
			[
				`test-p3508-${sha.slice(0, 8)}`,
				sha,
				opts.allowed_actions,
				opts.scoped_project_id,
			],
		);
		return rows[0].id;
	}

	beforeEach(async () => {
		// Fresh random tokens per test to avoid cross-test hash collisions
		fullScopeRaw = `p3508-full-${Math.random().toString(36).slice(2)}`;
		scopedRaw = `p3508-scoped-${Math.random().toString(36).slice(2)}`;
		tokenIds = [];

		// Full-scope token: scoped_project_id = NULL
		tokenIds.push(
			await insertToken({
				raw: fullScopeRaw,
				allowed_actions: ["project.create", "*"],
				scoped_project_id: null,
			}),
		);

		// Scoped token: only allowed for project_id = 1
		tokenIds.push(
			await insertToken({
				raw: scopedRaw,
				allowed_actions: ["project.create"],
				scoped_project_id: 1,
			}),
		);
	});

	afterEach(async () => {
		if (tokenIds.length) {
			await query(
				`DELETE FROM roadmap.operator_token WHERE id = ANY($1::int[])`,
				[tokenIds],
			);
		}
	});

	it("AC-4: NULL scoped_project_id token allows any targetProjectId", async () => {
		// Target project 99 (does not have to exist — scope check is token-side)
		const result = await authorizeOperatorByToken(fullScopeRaw, {
			action: "project.create",
			targetProjectId: 99,
		});
		assert.equal(
			result.decision,
			"allow",
			`expected allow but got ${result.decision}: ${result.failureReason}`,
		);
	});

	it("AC-4: NULL scoped_project_id token allows when no targetProjectId provided", async () => {
		const result = await authorizeOperatorByToken(fullScopeRaw, {
			action: "project.create",
		});
		assert.equal(result.decision, "allow");
	});

	it("AC-7: scoped token allows the matching project", async () => {
		const result = await authorizeOperatorByToken(scopedRaw, {
			action: "project.create",
			targetProjectId: 1,
		});
		assert.equal(
			result.decision,
			"allow",
			`expected allow for matching project but got ${result.decision}: ${result.failureReason}`,
		);
	});

	it("AC-7: scoped token denies a different targetProjectId", async () => {
		const result = await authorizeOperatorByToken(scopedRaw, {
			action: "project.create",
			targetProjectId: 2,
		});
		assert.equal(result.decision, "deny", "expected deny for mismatched project");
		assert.ok(
			result.failureReason?.includes("project scope"),
			`failure_reason should mention 'project scope', got: ${result.failureReason}`,
		);
	});

	it("AC-7: scope-mismatch denial is recorded in operator_audit_log", async () => {
		await authorizeOperatorByToken(scopedRaw, {
			action: "project.create",
			targetProjectId: 3,
		});
		// The audit row should be the most recent for this action
		const { rows } = await query<{ failure_reason: string; decision: string }>(
			`SELECT decision, failure_reason
			   FROM roadmap.operator_audit_log
			  WHERE action = 'project.create'
			    AND failure_reason LIKE 'project scope%'
			  ORDER BY id DESC
			  LIMIT 1`,
		);
		assert.ok(rows.length > 0, "expected audit row for scope mismatch");
		assert.equal(rows[0].decision, "deny");
		assert.ok(rows[0].failure_reason.includes("project scope"));
	});

	it("AC-7: scoped token with no targetProjectId is allowed (caller didn't assert a project)", async () => {
		// When caller provides no targetProjectId we cannot check scope — allow
		const result = await authorizeOperatorByToken(scopedRaw, {
			action: "project.create",
		});
		assert.equal(
			result.decision,
			"allow",
			"scoped token without targetProjectId should pass (no assertion to check against)",
		);
	});
});
