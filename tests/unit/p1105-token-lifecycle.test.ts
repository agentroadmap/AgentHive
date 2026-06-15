/**
 * P1105 Phase D — token lifecycle (token_issue / token_rotate) tests.
 *
 * Covers:
 *   AC-7/AC-13: token_issue mints an HS256 JWT decoding to
 *               {sub, aud='agenthive-msg-send', exp>now, iat, key_id}.
 *   AC-17:      operator-only authz — non-operator caller is rejected (403);
 *               operator caller succeeds. Issued token verifies under the SAME
 *               AGENTHIVE_USER_JWT_SECRET that verifyUserBearer() uses.
 *   AC-10/AC-15: token_rotate inserts an agent_token_key row keyed YYYY-MM with
 *               a 30d grace window, leaving any prior key row intact.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	agentContextStorage,
	type AgentContext,
} from "../../src/shared/identity/agent-context.ts";
import {
	currentKeyId,
	issueUserToken,
	rotateUserToken,
	TOKEN_AUDIENCE,
} from "../../src/apps/mcp-server/tools/messages/token-lifecycle.ts";
import { verifyUserBearer } from "../../src/apps/mcp-server/tools/messages/user-bearer-auth.ts";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

const SECRET = "p1105-lifecycle-test-secret-32bytes!!";
const USER = "user/gary"; // pre-registered agent_type='user' in agent_registry
const ROTATE_USER = "user/p1105-rotate-test";

function operatorCtx(principalId = "operator/test"): AgentContext {
	return {
		verified: {
			principal_id: principalId,
			principal_kind: "operator",
			parent_principal_id: null,
		},
	};
}

function agentCtx(): AgentContext {
	return {
		verified: {
			principal_id: "agent/spawn-123",
			principal_kind: "agent",
			parent_principal_id: null,
		},
	};
}

function run<T>(ctx: AgentContext, fn: () => Promise<T>): Promise<T> {
	return agentContextStorage.run(ctx, fn);
}

function decodePayload(jwt: string): Record<string, unknown> {
	const parts = jwt.split(".");
	assert.equal(parts.length, 3, "JWT must have 3 segments");
	return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

let savedSecret: string | undefined;
// agent_token_key ships in migration 283 (this proposal). When the migration
// has NOT yet been applied to the target DB, the rotate write-path assertions
// are skipped (not failed) — they are exercised once the migration lands.
let tokenKeyTableExists = false;

before(async () => {
	savedSecret = process.env.AGENTHIVE_USER_JWT_SECRET;
	process.env.AGENTHIVE_USER_JWT_SECRET = SECRET;
	try {
		const r = await getPool().query<{ reg: string | null }>(
			`SELECT to_regclass('roadmap.agent_token_key')::text AS reg`,
		);
		tokenKeyTableExists = r.rows[0]?.reg != null;
	} catch {
		tokenKeyTableExists = false;
	}
});

after(async () => {
	if (savedSecret === undefined) delete process.env.AGENTHIVE_USER_JWT_SECRET;
	else process.env.AGENTHIVE_USER_JWT_SECRET = savedSecret;
	// Clean up any rotate test rows so the table stays pristine.
	try {
		await getPool().query(
			`DELETE FROM roadmap.agent_token_key WHERE agent_identity = $1`,
			[ROTATE_USER],
		);
	} catch {
		/* non-fatal */
	}
	await closePool();
});

describe("token_issue — AC-7 / AC-13 / AC-17", () => {
	it("operator caller mints a JWT with the required claims", async () => {
		const r = await run(operatorCtx(), () =>
			issueUserToken({ agent_identity: USER, ttl_seconds: 3600 }),
		);
		assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
		assert.equal(r.status, 200);
		assert.ok(r.token, "token returned");

		const p = decodePayload(r.token as string);
		assert.equal(p.sub, USER);
		assert.equal(p.aud, TOKEN_AUDIENCE);
		assert.equal(typeof p.exp, "number");
		assert.equal(typeof p.iat, "number");
		assert.ok((p.exp as number) > Math.floor(Date.now() / 1000));
		assert.equal(p.key_id, currentKeyId());
	});

	it("issued token verifies under the same secret as msg_send (one verifier)", async () => {
		const r = await run(operatorCtx(), () =>
			issueUserToken({ agent_identity: USER, ttl_seconds: 600 }),
		);
		assert.equal(r.ok, true);
		const verdict = verifyUserBearer(r.token as string, USER);
		assert.equal(verdict.ok, true, `verify failed: ${verdict.error}`);
	});

	it("AC-17: non-operator (agent) caller is rejected with 403", async () => {
		const r = await run(agentCtx(), () =>
			issueUserToken({ agent_identity: USER, ttl_seconds: 3600 }),
		);
		assert.equal(r.ok, false);
		assert.equal(r.status, 403);
		assert.equal(r.reason, "not_operator");
		assert.equal(r.token, undefined);
	});

	it("AC-17: no principal context at all is rejected with 403", async () => {
		const r = await issueUserToken({ agent_identity: USER });
		assert.equal(r.ok, false);
		assert.equal(r.status, 403);
		assert.equal(r.reason, "missing_operator_principal");
	});

	it("rejects a non-user/* identity (400)", async () => {
		const r = await run(operatorCtx(), () =>
			issueUserToken({ agent_identity: "agent/notauser" }),
		);
		assert.equal(r.ok, false);
		assert.equal(r.status, 400);
		assert.equal(r.reason, "not_user_identity");
	});

	it("rejects an unregistered user/* identity (404)", async () => {
		const r = await run(operatorCtx(), () =>
			issueUserToken({ agent_identity: "user/never-registered-xyz" }),
		);
		assert.equal(r.ok, false);
		assert.equal(r.status, 404);
		assert.equal(r.reason, "identity_not_registered");
	});

	it("clamps ttl_seconds above the max window", async () => {
		const r = await run(operatorCtx(), () =>
			issueUserToken({ agent_identity: USER, ttl_seconds: 999999 }),
		);
		assert.equal(r.ok, true);
		const p = decodePayload(r.token as string);
		assert.ok((p.exp as number) - (p.iat as number) <= 3600);
	});
});

describe("token_rotate — AC-10 / AC-15 / AC-17", () => {
	it("AC-17: non-operator caller is rejected with 403 (no DB write)", async () => {
		const r = await run(agentCtx(), () =>
			rotateUserToken({
				agent_identity: ROTATE_USER,
				new_secret_hash: "deadbeef",
			}),
		);
		assert.equal(r.ok, false);
		assert.equal(r.status, 403);
		if (tokenKeyTableExists) {
			const cnt = await getPool().query<{ c: string }>(
				`SELECT COUNT(*)::text AS c FROM roadmap.agent_token_key WHERE agent_identity=$1`,
				[ROTATE_USER],
			);
			assert.equal(
				Number(cnt.rows[0].c),
				0,
				"deny path must not write a key row",
			);
		}
	});

	it("operator rotate inserts a YYYY-MM key with a 30d grace window", async (t) => {
		if (!tokenKeyTableExists) {
			t.skip("agent_token_key not migrated yet (migration 283)");
			return;
		}
		const r = await run(operatorCtx(), () =>
			rotateUserToken({
				agent_identity: ROTATE_USER,
				new_secret_hash: "newhash-1",
			}),
		);
		assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
		assert.equal(r.key_id, currentKeyId());

		const row = await getPool().query<{
			key_id: string;
			secret_key_hash: string;
			grace_days: string;
		}>(
			`SELECT key_id, secret_key_hash,
			        EXTRACT(EPOCH FROM (expires_at - NOW()))/86400 AS grace_days
			   FROM roadmap.agent_token_key
			  WHERE agent_identity=$1 AND key_id=$2`,
			[ROTATE_USER, currentKeyId()],
		);
		assert.equal(row.rows.length, 1);
		assert.equal(row.rows[0].secret_key_hash, "newhash-1");
		// ~30 days (allow slack for clock/test runtime)
		assert.ok(Number(row.rows[0].grace_days) > 29.5);
		assert.ok(Number(row.rows[0].grace_days) <= 30.1);
	});

	it("re-rotating within the same month refreshes the row (idempotent PK)", async (t) => {
		if (!tokenKeyTableExists) {
			t.skip("agent_token_key not migrated yet (migration 283)");
			return;
		}
		const r = await run(operatorCtx(), () =>
			rotateUserToken({
				agent_identity: ROTATE_USER,
				new_secret_hash: "newhash-2",
			}),
		);
		assert.equal(r.ok, true);
		const cnt = await getPool().query<{ c: string; h: string }>(
			`SELECT COUNT(*)::text AS c, MAX(secret_key_hash) AS h
			   FROM roadmap.agent_token_key WHERE agent_identity=$1`,
			[ROTATE_USER],
		);
		assert.equal(Number(cnt.rows[0].c), 1, "same-month rotate upserts, not duplicates");
		assert.equal(cnt.rows[0].h, "newhash-2");
	});

	it("rejects missing new_secret_hash (400)", async () => {
		const r = await run(operatorCtx(), () =>
			rotateUserToken({ agent_identity: ROTATE_USER }),
		);
		assert.equal(r.ok, false);
		assert.equal(r.status, 400);
		assert.equal(r.reason, "missing_new_secret_hash");
	});
});
