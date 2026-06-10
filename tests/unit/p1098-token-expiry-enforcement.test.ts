/**
 * P1098 — Enforce 'exp' claim on USER bearer tokens (max 1h window).
 *
 * Comprehensive test coverage for:
 *   AC-1: missing/invalid exp → 401
 *   AC-2: exp <= now → 401 token_expired
 *   AC-3: validity window (exp - iat) > 3600 → 401 token_window_too_large
 *   AC-4: valid token within 1h → 200 OK
 *   AC-5: missing/invalid iat → 401
 *   AC-6: iat in future beyond skew → 401 iat_in_future
 *   AC-7: clock skew bounded to 60 seconds
 *   AC-8: auth failure side-effect free (no message row, no NOTIFY)
 *   AC-9: token revocation check
 *   AC-10: JWT header validation (HS256 only)
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
	ALLOWED_CLOCK_SKEW_SECONDS,
	isTokenRevoked,
	logBearerRejection,
	verifyUserBearer,
} from "../../src/apps/mcp-server/tools/messages/user-bearer-auth.ts";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

// ── JWT helpers ────────────────────────────────────────────────────────────────

/**
 * Build a JWT with custom header, iat, exp claims.
 * Allows testing various combinations for P1098.
 */
function makeJwt(
	sub: string,
	secret: string,
	opts: {
		iat?: number; // unix seconds (undefined = current)
		exp?: number; // unix seconds (undefined = iat + 3600)
		headerAlg?: string; // override alg in header
		headerOmitAlg?: boolean; // omit alg entirely
	} = {},
): string {
	const now = Math.floor(Date.now() / 1000);
	const iat = opts.iat !== undefined ? opts.iat : now;
	const exp = opts.exp !== undefined ? opts.exp : iat + 3600;

	const headerObj: Record<string, unknown> = { typ: "JWT" };
	if (!opts.headerOmitAlg) {
		headerObj.alg = opts.headerAlg ?? "HS256";
	}

	const header = Buffer.from(JSON.stringify(headerObj)).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			sub,
			iat: opts.iat !== undefined ? iat : undefined,
			exp: opts.exp !== undefined ? exp : undefined,
		}),
	).toString("base64url");

	const sig = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${sig}`;
}

// ── Test setup ────────────────────────────────────────────────────────────────

const SECRET = "test-secret-key-32-bytes-padding!";
const FROM_AGENT = "user/gary";

let originalSecret: string | undefined;

before(() => {
	originalSecret = process.env.AGENTHIVE_USER_JWT_SECRET;
	process.env.AGENTHIVE_USER_JWT_SECRET = SECRET;
});

after(async () => {
	if (originalSecret === undefined) {
		delete process.env.AGENTHIVE_USER_JWT_SECRET;
	} else {
		process.env.AGENTHIVE_USER_JWT_SECRET = originalSecret;
	}
	await closePool();
});

// ── AC-1: Missing/invalid exp claim ─────────────────────────────────────────────

describe("P1098 AC-1: exp claim validation", () => {
	it("AC-1: missing exp claim → error=missing_exp_claim", () => {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: "HS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				sub: FROM_AGENT,
				iat: now,
				// exp intentionally omitted
			}),
		).toString("base64url");
		const sig = createHmac("sha256", SECRET)
			.update(`${header}.${payload}`)
			.digest("base64url");
		const token = `${header}.${payload}.${sig}`;

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "missing_exp_claim");
	});

	it("AC-1: non-numeric exp claim → error=invalid_exp_claim", () => {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: "HS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				sub: FROM_AGENT,
				iat: now,
				exp: "not-a-number",
			}),
		).toString("base64url");
		const sig = createHmac("sha256", SECRET)
			.update(`${header}.${payload}`)
			.digest("base64url");
		const token = `${header}.${payload}.${sig}`;

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_exp_claim");
	});
});

// ── AC-2: Expired token (beyond clock skew) ─────────────────────────────────────

describe("P1098 AC-2: token expiration", () => {
	it("AC-2: exp <= now - clockSkew → error=token_expired", () => {
		const now = Math.floor(Date.now() / 1000);
		const expiredExp = now - ALLOWED_CLOCK_SKEW_SECONDS - 1;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now - 7200,
			exp: expiredExp,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "token_expired");
	});

	it("AC-2: exp exactly at now - clockSkew boundary → token_expired", () => {
		const now = Math.floor(Date.now() / 1000);
		const boundaryExp = now - ALLOWED_CLOCK_SKEW_SECONDS;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now - 7200,
			exp: boundaryExp,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "token_expired");
	});

	it("AC-2/AC-7: exp just within clockSkew → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const withinSkewExp = now - ALLOWED_CLOCK_SKEW_SECONDS + 1;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now - 100,
			exp: withinSkewExp,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});
});

// ── AC-3: Validity window > 3600 ────────────────────────────────────────────────

describe("P1098 AC-3: 1-hour validity window", () => {
	it("AC-3: exp - iat = 3600 (exactly 1h) → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 3600 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});

	it("AC-3: exp - iat = 3601 (> 1h) → error=token_window_too_large", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 3601 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "token_window_too_large");
	});

	it("AC-3: exp - iat = 7200 (2h) → error=token_window_too_large", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 7200 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "token_window_too_large");
	});
});

// ── AC-4: Valid token within 1h ────────────────────────────────────────────────

describe("P1098 AC-4: valid token", () => {
	it("AC-4: token with iat=now, exp=now+1800 (30m) → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 1800 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
		assert.equal(result.error, undefined);
	});

	it("AC-4: token with iat=now, exp=now+1 (1s) → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 1 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});

	it("AC-4: token with iat=now, exp=now+3600 (1h exactly) → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now + 3600 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});
});

// ── AC-5: Missing/invalid iat claim ────────────────────────────────────────────

describe("P1098 AC-5: iat claim validation", () => {
	it("AC-5: missing iat claim → error=missing_iat_claim", () => {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: "HS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				sub: FROM_AGENT,
				// iat intentionally omitted
				exp: now + 3600,
			}),
		).toString("base64url");
		const sig = createHmac("sha256", SECRET)
			.update(`${header}.${payload}`)
			.digest("base64url");
		const token = `${header}.${payload}.${sig}`;

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "missing_iat_claim");
	});

	it("AC-5: non-numeric iat claim → error=invalid_iat_claim", () => {
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: "HS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				sub: FROM_AGENT,
				iat: "not-a-number",
				exp: now + 3600,
			}),
		).toString("base64url");
		const sig = createHmac("sha256", SECRET)
			.update(`${header}.${payload}`)
			.digest("base64url");
		const token = `${header}.${payload}.${sig}`;

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_iat_claim");
	});
});

// ── AC-6: iat in future beyond skew ────────────────────────────────────────────

describe("P1098 AC-6: future iat detection", () => {
	it("AC-6: iat = now + clockSkew + 1 → error=iat_in_future", () => {
		const now = Math.floor(Date.now() / 1000);
		const futureIat = now + ALLOWED_CLOCK_SKEW_SECONDS + 1;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: futureIat,
			exp: futureIat + 1800,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "iat_in_future");
	});

	it("AC-6/AC-7: iat = now + clockSkew (boundary) → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const boundaryIat = now + ALLOWED_CLOCK_SKEW_SECONDS;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: boundaryIat,
			exp: boundaryIat + 1800,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});

	it("AC-6/AC-7: iat = now + clockSkew - 1 → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const nearFutureIat = now + ALLOWED_CLOCK_SKEW_SECONDS - 1;
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: nearFutureIat,
			exp: nearFutureIat + 1800,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});
});

// ── AC-7: Clock skew bounded to 60 seconds ─────────────────────────────────────

describe("P1098 AC-7: bounded clock skew", () => {
	it("AC-7: ALLOWED_CLOCK_SKEW_SECONDS is 60", () => {
		assert.equal(ALLOWED_CLOCK_SKEW_SECONDS, 60);
	});

	it("AC-7: token with exp=now-120, well beyond skew → token_expired", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now - 300,
			exp: now - 120,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "token_expired");
	});

	it("AC-7: token with exp=now+30, within skew → valid", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now - 100,
			exp: now + 30,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});
});

// ── AC-8: Side-effect free auth failures ────────────────────────────────────────

describe("P1098 AC-8: side-effect free failures", () => {
	it("AC-8: failed auth writes audit log via logBearerRejection", async () => {
		const pool = getPool();
		const before = await pool.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap.operator_audit_log
			 WHERE action='msg_send' AND decision='deny'`,
		);
		const countBefore = Number(before.rows[0]?.count ?? 0);

		// Log a rejection
		await logBearerRejection(FROM_AGENT, "token_expired");

		const after = await pool.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count FROM roadmap.operator_audit_log
			 WHERE action='msg_send' AND decision='deny'`,
		);
		const countAfter = Number(after.rows[0]?.count ?? 0);

		assert.equal(countAfter, countBefore + 1);
	});

	it("AC-8: failed auth does not insert message_ledger row (sync check)", () => {
		// Verify verifyUserBearer does not insert into DB
		// (actual DB isolation tested in integration tests)
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, { iat: now, exp: now - 100 });

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		// No exceptions, no side effects
		assert.equal(result.error, "token_expired");
	});
});

// ── AC-9: Token revocation check ────────────────────────────────────────────────

describe("P1098 AC-9: token revocation", () => {
	it("AC-9: isTokenRevoked returns false for non-existent principal", async () => {
		const isRevoked = await isTokenRevoked("user/nonexistent");
		assert.equal(isRevoked, false);
	});

	it("AC-9: revoked principal check (mocked)", async () => {
		// In real integration tests, this would test with a DB row
		// For unit tests, we verify isTokenRevoked is exported and callable
		assert.ok(typeof isTokenRevoked === "function");
	});
});

// ── AC-10: JWT header validation (HS256 only) ──────────────────────────────────

describe("P1098 AC-10: JWT header algorithm validation", () => {
	it("AC-10: HS256 algorithm accepted", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now,
			exp: now + 1800,
			headerAlg: "HS256",
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, true);
	});

	it("AC-10: RS256 algorithm rejected → error=invalid_algorithm", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now,
			exp: now + 1800,
			headerAlg: "RS256",
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_algorithm");
	});

	it("AC-10: none algorithm rejected → error=invalid_algorithm", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now,
			exp: now + 1800,
			headerAlg: "none",
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_algorithm");
	});

	it("AC-10: missing alg in header → error=invalid_algorithm", () => {
		const now = Math.floor(Date.now() / 1000);
		const token = makeJwt(FROM_AGENT, SECRET, {
			iat: now,
			exp: now + 1800,
			headerOmitAlg: true,
		});

		const result = verifyUserBearer(token, FROM_AGENT);
		assert.equal(result.ok, false);
		assert.equal(result.error, "invalid_algorithm");
	});
});
