/**
 * P3508 AC-7: Operator auth project-scope tests.
 *
 * Verifies:
 *   1. Token with scoped_project_id=<N> + caller targetProjectId=<M≠N>
 *      → decision='deny', httpStatus=403, failureReason containing 'project scope',
 *        one audit row with that failure_reason.
 *   2. Token with scoped_project_id=NULL (full scope) + any targetProjectId
 *      → decision='allow' regardless of targetProjectId.
 *
 * Run with:
 *   npx tsx --test src/apps/server/operator-auth.test.ts
 */

import { strict as assert } from "assert";
import { test, after } from "node:test";
import { createHash } from "node:crypto";
import { query } from "../../infra/postgres/pool.ts";
import { authorizeOperatorByToken } from "./operator-auth.ts";

function sha256(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

const TEST_PREFIX = `p3508-test-${Date.now()}`;

async function insertToken(opts: {
	label: string;
	allowedActions?: string[];
	scopedProjectId?: number | null;
}): Promise<{ id: number; rawToken: string }> {
	const rawToken = `${TEST_PREFIX}-${opts.label}`;
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap.operator_token
		   (operator_name, token_sha256, allowed_actions, scoped_project_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id`,
		[
			`test-operator-${opts.label}`,
			sha256(rawToken),
			opts.allowedActions ?? ["*"],
			opts.scopedProjectId ?? null,
		],
	);
	return { id: rows[0].id, rawToken };
}

async function countAuditRows(tokenId: number, failureReasonPattern: string): Promise<number> {
	const { rows } = await query<{ cnt: string }>(
		`SELECT COUNT(*)::int AS cnt
		   FROM roadmap.operator_audit_log
		  WHERE token_id = $1
		    AND failure_reason ILIKE $2`,
		[tokenId, `%${failureReasonPattern}%`],
	);
	return Number(rows[0]?.cnt ?? 0);
}

const insertedTokenIds: number[] = [];

after(async () => {
	if (insertedTokenIds.length > 0) {
		await query(
			`DELETE FROM roadmap.operator_token WHERE id = ANY($1::int[])`,
			[insertedTokenIds],
		);
	}
});

test("AC-7(a): scoped token rejects cross-project call with 403 + audit row", async () => {
	const { id, rawToken } = await insertToken({
		label: "scoped-deny",
		allowedActions: ["*"],
		scopedProjectId: 2,
	});
	insertedTokenIds.push(id);

	const outcome = await authorizeOperatorByToken(rawToken, {
		action: "project.create",
		targetProjectId: 3,
	});

	assert.equal(outcome.decision, "deny", "decision must be deny");
	assert.equal(outcome.httpStatus, 403, "httpStatus must be 403");
	assert.ok(
		outcome.failureReason?.toLowerCase().includes("project scope"),
		`failureReason should contain 'project scope', got: ${outcome.failureReason}`,
	);

	const auditCount = await countAuditRows(id, "project scope");
	assert.ok(auditCount >= 1, `Expected at least 1 audit row with 'project scope', got ${auditCount}`);
});

test("AC-7(b): full-scope token (scoped_project_id=NULL) allows any targetProjectId", async () => {
	const { id, rawToken } = await insertToken({
		label: "full-scope-allow",
		allowedActions: ["*"],
		scopedProjectId: null,
	});
	insertedTokenIds.push(id);

	const outcome = await authorizeOperatorByToken(rawToken, {
		action: "project.create",
		targetProjectId: 3,
	});

	assert.equal(outcome.decision, "allow", "full-scope token should allow any targetProjectId");
	assert.equal(outcome.httpStatus, 200);
});

test("AC-7(c): scoped token allows matching project", async () => {
	const { id, rawToken } = await insertToken({
		label: "scoped-allow",
		allowedActions: ["*"],
		scopedProjectId: 1,
	});
	insertedTokenIds.push(id);

	const outcome = await authorizeOperatorByToken(rawToken, {
		action: "project.create",
		targetProjectId: 1,
	});

	assert.equal(outcome.decision, "allow", "scoped token should allow matching project");
	assert.equal(outcome.httpStatus, 200);
});

test("AC-7(d): scoped token allows call with no targetProjectId (caller-unscoped path)", async () => {
	const { id, rawToken } = await insertToken({
		label: "scoped-no-target",
		allowedActions: ["*"],
		scopedProjectId: 2,
	});
	insertedTokenIds.push(id);

	// No targetProjectId supplied → scope check is skipped (caller did not assert a target)
	const outcome = await authorizeOperatorByToken(rawToken, {
		action: "project.create",
	});

	assert.equal(outcome.decision, "allow", "scoped token with no targetProjectId should allow");
});

test("AC-4 (default operator): single-project deployment (no scoped_project_id) is never locked out", async () => {
	const { id, rawToken } = await insertToken({
		label: "default-op",
		allowedActions: ["*"],
		scopedProjectId: null,
	});
	insertedTokenIds.push(id);

	// Simulate the default operator acting on project_id=1
	const outcome = await authorizeOperatorByToken(rawToken, {
		action: "agent.stop",
		targetProjectId: 1,
	});

	assert.equal(outcome.decision, "allow");
});
