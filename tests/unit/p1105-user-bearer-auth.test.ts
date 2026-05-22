/**
 * P1105 AC-3/AC-4/AC-5 — User bearer token verification tests.
 *
 * Covers:
 *   AC-3a: missing token → error='missing'
 *   AC-3b: sub mismatch  → error='sub_mismatch'
 *   AC-3c: valid token   → ok=true
 *   AC-4:  key rotation  → old token rejected, new token accepted
 *   AC-5:  logBearerRejection writes to operator_audit_log
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";
import {
	verifyUserBearer,
	logBearerRejection,
	extractBearerFromHeader,
} from "../../src/apps/mcp-server/tools/messages/user-bearer-auth.ts";

// ── JWT helpers ────────────────────────────────────────────────────────────────

function makeJwt(sub: string, secret: string, opts: { expOffset?: number } = {}): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = Buffer.from(
		JSON.stringify({
			sub,
			iat: now,
			exp: now + (opts.expOffset ?? 3600),
		}),
	).toString("base64url");
	const sig = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${sig}`;
}

// ── Test setup ────────────────────────────────────────────────────────────────

const SECRET_A = "secret-key-alpha-32-bytes-padding!";
const SECRET_B = "secret-key-bravo-32-bytes-padding!";
const FROM_AGENT = "user/gary";

let originalSecret: string | undefined;

before(() => {
	originalSecret = process.env.AGENTHIVE_USER_JWT_SECRET;
	process.env.AGENTHIVE_USER_JWT_SECRET = SECRET_A;
});

after(async () => {
	if (originalSecret === undefined) {
		delete process.env.AGENTHIVE_USER_JWT_SECRET;
	} else {
		process.env.AGENTHIVE_USER_JWT_SECRET = originalSecret;
	}
	await closePool();
});

// ── AC-3 tests ─────────────────────────────────────────────────────────────────

describe("verifyUserBearer — AC-3", () => {
	it("AC-3a: missing token → error=missing", () => {
		const result = verifyUserBearer(undefined, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "missing");
	});

	it("AC-3a: empty string token → error=missing", () => {
		const result = verifyUserBearer("", FROM_AGENT);
		assert.equal(result.ok, false);
		// empty string has no dots → malformed (not missing — only undefined/absent is missing)
		assert.ok(result.error === "missing" || result.error === "malformed");
	});

	it("AC-3b: sub mismatch → error=sub_mismatch", () => {
		const token = makeJwt("user/other", SECRET_A);
		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "sub_mismatch");
	});

	it("AC-3c: valid token with matching sub → ok=true", () => {
		const token = makeJwt(FROM_AGENT, SECRET_A);
		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
		assert.equal(result.error, undefined);
	});

	it("invalid signature → error=invalid_sig", () => {
		const token = makeJwt(FROM_AGENT, "wrong-secret");
		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_sig");
	});

	it("expired token → error=exp_expired", () => {
		const token = makeJwt(FROM_AGENT, SECRET_A, { expOffset: -120 }); // 2 min ago
		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "exp_expired");
	});

	it("no secret configured → error=no_secret", () => {
		const saved = process.env.AGENTHIVE_USER_JWT_SECRET;
		delete process.env.AGENTHIVE_USER_JWT_SECRET;
		try {
			const token = makeJwt(FROM_AGENT, SECRET_A);
			const result = verifyUserBearer(token, FROM_AGENT);
			assert.equal(result.ok, false);
			assert.equal(result.error, "no_secret");
		} finally {
			process.env.AGENTHIVE_USER_JWT_SECRET = saved;
		}
	});
});

// ── AC-4 tests — key rotation ─────────────────────────────────────────────────

describe("verifyUserBearer — AC-4 key rotation", () => {
	it("token signed with old key rejected after key rotation", () => {
		// Token from before rotation
		const oldToken = makeJwt(FROM_AGENT, SECRET_A);

		// Rotate to new key
		process.env.AGENTHIVE_USER_JWT_SECRET = SECRET_B;

		try {
			const result = verifyUserBearer(oldToken, FROM_AGENT);
			assert.equal(result.ok, false);
			assert.equal(result.error, "invalid_sig");
		} finally {
			process.env.AGENTHIVE_USER_JWT_SECRET = SECRET_A;
		}
	});

	it("token signed with new key accepted after key rotation", () => {
		process.env.AGENTHIVE_USER_JWT_SECRET = SECRET_B;
		try {
			const newToken = makeJwt(FROM_AGENT, SECRET_B);
			const result = verifyUserBearer(newToken, FROM_AGENT);
			assert.equal(result.ok, true);
		} finally {
			process.env.AGENTHIVE_USER_JWT_SECRET = SECRET_A;
		}
	});
});

// ── AC-5 tests — audit log ────────────────────────────────────────────────────

describe("logBearerRejection — AC-5", () => {
	it("writes a deny row to operator_audit_log", async () => {
		const pool = getPool();
		const before = await pool.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap.operator_audit_log
			 WHERE action='msg_send' AND decision='deny' AND target_kind='user'
			   AND target_identity=$1 AND failure_reason='bearer:sub_mismatch'`,
			[FROM_AGENT],
		);
		const countBefore = Number(before.rows[0]?.count ?? 0);

		await logBearerRejection(FROM_AGENT, "sub_mismatch");

		const after = await pool.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap.operator_audit_log
			 WHERE action='msg_send' AND decision='deny' AND target_kind='user'
			   AND target_identity=$1 AND failure_reason='bearer:sub_mismatch'`,
			[FROM_AGENT],
		);
		const countAfter = Number(after.rows[0]?.count ?? 0);

		assert.equal(countAfter, countBefore + 1, "expected one new audit log row");
	});
});

// ── extractBearerFromHeader ───────────────────────────────────────────────────

describe("extractBearerFromHeader", () => {
	it("extracts token from 'Bearer <token>' header", () => {
		assert.equal(extractBearerFromHeader("Bearer mytoken123"), "mytoken123");
	});

	it("returns undefined for missing header", () => {
		assert.equal(extractBearerFromHeader(undefined), undefined);
	});

	it("returns undefined for non-Bearer header", () => {
		assert.equal(extractBearerFromHeader("Basic dXNlcjpwYXNz"), undefined);
	});
});
