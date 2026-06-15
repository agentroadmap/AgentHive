/**
 * P1391 — pure unit tests for the TypeScript lease-liveness helper.
 *
 * Mirrors AC-1 (lease_is_live semantics) and AC-22 (scalar args) at the
 * application layer. No DB — fully deterministic via an injected `now`.
 *
 * Run: node --import jiti/register --test tests/unit/p1391-lease-liveness.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	leaseIsLive,
	leaseLiveSql,
	LEASE_LIVE_SQL,
} from "../../src/core/proposal/lease-liveness.ts";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("P1391 AC-1/AC-22 — leaseIsLive()", () => {
	it("fresh lease (released_at NULL, expires in the future) is LIVE", () => {
		const future = new Date(NOW.getTime() + 30 * 60 * 1000);
		assert.equal(leaseIsLive(null, future, NOW), true);
	});

	it("expired lease (released_at NULL, expires 1s in the past) is NOT live", () => {
		const past = new Date(NOW.getTime() - 1000);
		assert.equal(leaseIsLive(null, past, NOW), false);
	});

	it("released lease is NOT live even when expires_at is still in the future", () => {
		const future = new Date(NOW.getTime() + 30 * 60 * 1000);
		const released = new Date(NOW.getTime() - 60 * 1000);
		assert.equal(leaseIsLive(released, future, NOW), false);
	});

	it("expires_at exactly == now is NOT live (strict >, matches SQL expires_at > now())", () => {
		assert.equal(leaseIsLive(null, NOW, NOW), false);
	});

	it("accepts ISO string timestamps as well as Date", () => {
		assert.equal(
			leaseIsLive(null, "2026-06-15T12:30:00Z", NOW),
			true,
		);
		assert.equal(
			leaseIsLive("2026-06-15T11:00:00Z", "2026-06-15T12:30:00Z", NOW),
			false,
		);
	});

	it("defaults `now` to the real clock when omitted (smoke)", () => {
		const farFuture = new Date(Date.now() + 60 * 60 * 1000);
		const farPast = new Date(Date.now() - 60 * 60 * 1000);
		assert.equal(leaseIsLive(null, farFuture), true);
		assert.equal(leaseIsLive(null, farPast), false);
	});
});

describe("P1391 AC-8 — leaseLiveSql() canonical predicate", () => {
	it("emits the aliased two-clause predicate", () => {
		assert.equal(
			leaseLiveSql("pl"),
			"pl.released_at IS NULL AND pl.expires_at > now()",
		);
	});

	it("emits the unaliased form", () => {
		assert.equal(
			leaseLiveSql(),
			"released_at IS NULL AND expires_at > now()",
		);
		assert.equal(LEASE_LIVE_SQL, "released_at IS NULL AND expires_at > now()");
	});

	it("always includes BOTH halves of liveness (never a bare released_at check)", () => {
		const sql = leaseLiveSql("x");
		assert.match(sql, /released_at IS NULL/);
		assert.match(sql, /expires_at > now\(\)/);
	});
});
