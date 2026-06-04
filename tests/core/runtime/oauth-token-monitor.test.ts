/**
 * P1967: OAuth Token Monitor Unit Tests
 *
 * Tests for expiry tracking (AC-4) and rotation signals.
 * No DB, no network — pure time-based computations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeExpiryDays,
	checkOAuthTokenExpiry,
	emitOAuthRotateSignal,
	type OAuthTokenStatus,
	type LogDeps,
} from "../../../src/core/runtime/oauth-token-monitor.ts";

// ─── Expiry Computation Tests ──────────────────────────────────────────────────

describe("OAuthTokenMonitor — computeExpiryDays", () => {
	it("returns positive days when token is not yet expired", () => {
		// Token provisioned 100 days ago
		const now = Date.now();
		const provisioned_at = now - 100 * 24 * 60 * 60 * 1000;
		const daysUntilExpiry = computeExpiryDays(provisioned_at);
		// 365 - 100 = 265 days remaining
		assert.ok(daysUntilExpiry > 250 && daysUntilExpiry <= 265, `expected ~265 days, got ${daysUntilExpiry}`);
	});

	it("returns negative days when token is expired", () => {
		// Token provisioned 400 days ago (expired 35+ days ago)
		const now = Date.now();
		const provisioned_at = now - 400 * 24 * 60 * 60 * 1000;
		const daysUntilExpiry = computeExpiryDays(provisioned_at);
		assert.ok(daysUntilExpiry < 0, `expected negative days, got ${daysUntilExpiry}`);
	});

	it("returns ~0 days when token is about to expire", () => {
		// Token provisioned 364 days ago (expires tomorrow)
		const now = Date.now();
		const provisioned_at = now - 364 * 24 * 60 * 60 * 1000;
		const daysUntilExpiry = computeExpiryDays(provisioned_at);
		assert.ok(daysUntilExpiry >= 0 && daysUntilExpiry <= 2, `expected ~1 day, got ${daysUntilExpiry}`);
	});

	it("returns ~365 days for a freshly provisioned token", () => {
		// Token provisioned just now
		const now = Date.now();
		const daysUntilExpiry = computeExpiryDays(now);
		assert.ok(daysUntilExpiry >= 364 && daysUntilExpiry <= 365, `expected ~365 days, got ${daysUntilExpiry}`);
	});
});

// ─── Expiry Check with Warning Threshold (AC-4) ─────────────────────────────────

describe("OAuthTokenMonitor — checkOAuthTokenExpiry", () => {
	it("returns OAuthTokenStatus with correct shape", () => {
		const now = Date.now();
		const provisioned_at = now - 100 * 24 * 60 * 60 * 1000;
		const status = checkOAuthTokenExpiry(provisioned_at);

		assert.ok(typeof status.daysUntilExpiry === "number", "daysUntilExpiry must be number");
		assert.ok(typeof status.isExpiring === "boolean", "isExpiring must be boolean");
		assert.ok(typeof status.provisioned_at === "number", "provisioned_at must be number");
		assert.ok(typeof status.expires_at === "number", "expires_at must be number");
	});

	it("sets isExpiring=false when token has > 30 days remaining", () => {
		// Token provisioned 100 days ago (265 days remaining)
		const now = Date.now();
		const provisioned_at = now - 100 * 24 * 60 * 60 * 1000;
		const status = checkOAuthTokenExpiry(provisioned_at, 30);
		assert.equal(status.isExpiring, false, "token should not be expiring with 265 days left");
	});

	it("sets isExpiring=true when token has <= 30 days remaining (AC-4)", () => {
		// Token provisioned 345 days ago (20 days remaining)
		const now = Date.now();
		const provisioned_at = now - 345 * 24 * 60 * 60 * 1000;
		const status = checkOAuthTokenExpiry(provisioned_at, 30);
		assert.equal(status.isExpiring, true, "token should be expiring with 20 days left");
	});

	it("respects custom warn_days_threshold", () => {
		// Token provisioned 340 days ago (25 days remaining)
		const now = Date.now();
		const provisioned_at = now - 340 * 24 * 60 * 60 * 1000;

		// With threshold=30, should warn
		const status30 = checkOAuthTokenExpiry(provisioned_at, 30);
		assert.equal(status30.isExpiring, true, "should warn with 25 days left and threshold=30");

		// With threshold=20, should not warn
		const status20 = checkOAuthTokenExpiry(provisioned_at, 20);
		assert.equal(status20.isExpiring, false, "should not warn with 25 days left and threshold=20");
	});

	it("calls warn function when expiring (AC-4)", () => {
		const now = Date.now();
		const provisioned_at = now - 345 * 24 * 60 * 60 * 1000; // 20 days left
		let warnCalled = false;
		let warnMsg = "";

		const deps: LogDeps = {
			warn: (msg: string) => {
				warnCalled = true;
				warnMsg = msg;
			},
		};

		checkOAuthTokenExpiry(provisioned_at, 30, deps);
		assert.equal(warnCalled, true, "warn must be called when token is expiring");
		assert.ok(warnMsg.includes("OAUTH_TOKEN_EXPIRING"), "warn message must include OAUTH_TOKEN_EXPIRING");
	});

	it("returns correct expires_at timestamp", () => {
		const LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const provisioned_at = now - 100 * 24 * 60 * 60 * 1000;
		const status = checkOAuthTokenExpiry(provisioned_at);

		const expectedExpires = provisioned_at + LIFETIME_MS;
		// Allow 1s tolerance for test execution time
		assert.ok(Math.abs(status.expires_at - expectedExpires) < 1000, "expires_at must be provisioned + 365 days");
	});
});

// ─── Rotation Signal Tests ────────────────────────────────────────────────────────

describe("OAuthTokenMonitor — emitOAuthRotateSignal", () => {
	it("returns signal with OAUTH_TOKEN_ROTATE code", () => {
		const signal = emitOAuthRotateSignal(401, "claude --print returned 401 UNAUTHORIZED");
		assert.equal(signal.code, "OAUTH_TOKEN_ROTATE", "code must be OAUTH_TOKEN_ROTATE");
	});

	it("captures status_code in signal", () => {
		const signal = emitOAuthRotateSignal(401, "unauthorized");
		assert.equal(signal.status_code, 401);
	});

	it("captures reason in signal", () => {
		const reason = "claude --print returned 401 UNAUTHORIZED";
		const signal = emitOAuthRotateSignal(401, reason);
		assert.equal(signal.reason, reason);
	});

	it("captures occurred_at as current timestamp", () => {
		const before = Date.now();
		const signal = emitOAuthRotateSignal(401, "test");
		const after = Date.now();
		assert.ok(signal.occurred_at >= before && signal.occurred_at <= after, "occurred_at must be ~now");
	});

	it("can emit signal for 403 Forbidden", () => {
		const signal = emitOAuthRotateSignal(403, "subscription quota exceeded");
		assert.equal(signal.status_code, 403);
		assert.ok(signal.reason.includes("quota"), "reason preserved");
	});

	it("calls error function when emitting rotate signal (AC-4)", () => {
		let errorCalled = false;
		let errorMsg = "";

		const deps: LogDeps = {
			error: (msg: string) => {
				errorCalled = true;
				errorMsg = msg;
			},
		};

		emitOAuthRotateSignal(401, "unauthorized access", deps);
		assert.equal(errorCalled, true, "error must be called when emitting rotate signal");
		assert.ok(errorMsg.includes("OAUTH_TOKEN_ROTATE"), "error message must include OAUTH_TOKEN_ROTATE");
	});
});

// ─── Integration: Monitoring Workflow ──────────────────────────────────────────────

describe("OAuthTokenMonitor — integration scenarios", () => {
	it("workflow: provision token, check expiry at day 340", () => {
		const LIFECYCLE_MS = 340 * 24 * 60 * 60 * 1000;
		const provisioned_at = Date.now() - LIFECYCLE_MS;
		const status = checkOAuthTokenExpiry(provisioned_at, 30);
		assert.equal(status.isExpiring, true, "token should trigger warning at day 340");
		assert.ok(status.daysUntilExpiry > 0 && status.daysUntilExpiry <= 30, "should have < 30 days left");
	});

	it("workflow: catch a 401, emit rotate signal and check expiry", () => {
		// Token is expiring
		const provisioned_at = Date.now() - 345 * 24 * 60 * 60 * 1000;
		const status = checkOAuthTokenExpiry(provisioned_at, 30);

		// And we got a 401
		const signal = emitOAuthRotateSignal(401, "spawn failed with 401");

		assert.equal(status.isExpiring, true);
		assert.equal(signal.code, "OAUTH_TOKEN_ROTATE");
		assert.ok(status.daysUntilExpiry < 30);
	});
});
