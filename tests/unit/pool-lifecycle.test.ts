/**
 * P1123 — pool lifecycle sentinel regression tests.
 *
 * Validates:
 *   AC-4: in "long-running" mode, closePool() is a no-op AND getPool()
 *         with a changed signature keeps the existing pool. Subsequent
 *         calls return the original pool reference.
 *   AC-5: default "one-shot" mode preserves CLI/test semantics —
 *         closePool() ends the pool and getPool() with a changed signature
 *         creates a fresh pool.
 *
 * These tests exercise the FUNCTION behavior without requiring a live
 * Postgres connection. `new Pool({...})` is constructed but never queried,
 * so the test is fast and DB-free.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	closePool,
	getPool,
	getPoolLifecycleMode,
	setPoolLifecycleMode,
} from "../../src/infra/postgres/pool.ts";

// Capture console.warn output so we can assert on the sentinel's caller-stack log.
let warnCalls: Array<string> = [];
const originalWarn = console.warn;
function installWarnCapture() {
	warnCalls = [];
	console.warn = (...args: unknown[]) => {
		warnCalls.push(args.map((a) => String(a)).join(" "));
	};
}
function restoreWarn() {
	console.warn = originalWarn;
}

describe("P1123 pool lifecycle sentinel", () => {
	beforeEach(() => {
		// Start every test from a known-clean state.
		setPoolLifecycleMode("one-shot");
		installWarnCapture();
	});

	afterEach(async () => {
		restoreWarn();
		// Cleanup: in one-shot mode the closePool actually closes; in long-running
		// it's a no-op. We end the pool either way to avoid leaking between tests.
		setPoolLifecycleMode("one-shot");
		try {
			await closePool();
		} catch {
			/* ignore cleanup errors */
		}
	});

	it("default mode is 'one-shot' (CLI / test semantics preserved)", () => {
		// After beforeEach reset, mode must be 'one-shot' so CLI subcommands and
		// tests close the pool cleanly on exit.
		assert.strictEqual(getPoolLifecycleMode(), "one-shot");
	});

	it("AC-4 long-running mode: closePool() is a no-op and pool stays alive", async () => {
		const cfg = { host: "127.0.0.1", port: 5432, user: "test-user-a", database: "test-db" };
		const p1 = getPool(cfg);

		setPoolLifecycleMode("long-running");
		await closePool();

		// The pool reference returned for the same config must be IDENTICAL —
		// proof that pool.end() did not run inside closePool().
		const p2 = getPool(cfg);
		assert.strictEqual(p2, p1, "closePool() must not end the pool in long-running mode");

		// And a caller-stack log was emitted at warn.
		assert.ok(
			warnCalls.some((line) => line.includes("closePool() refused in long-running mode")),
			"expected console.warn with sentinel message",
		);
	});

	it("AC-4 (Phase 2.1) long-running mode: getPool() with changed signature keeps existing pool", () => {
		const cfgA = { host: "127.0.0.1", port: 5432, user: "test-user-b", database: "test-db" };
		const cfgB = { host: "127.0.0.1", port: 5432, user: "test-user-different", database: "test-db" };

		const p1 = getPool(cfgA);
		setPoolLifecycleMode("long-running");

		// In long-running mode, requesting a different config must NOT end the
		// existing pool — same reference is returned.
		const p2 = getPool(cfgB);
		assert.strictEqual(p2, p1, "signature change must not end the pool in long-running mode");

		assert.ok(
			warnCalls.some((line) =>
				line.includes("getPool() signature change refused in long-running mode"),
			),
			"expected console.warn with signature-change sentinel message",
		);
	});

	it("AC-5 one-shot mode: closePool() ends the pool and the next getPool() is fresh", async () => {
		const cfg = { host: "127.0.0.1", port: 5432, user: "test-user-c", database: "test-db" };
		const p1 = getPool(cfg);

		// Default mode is one-shot.
		await closePool();

		const p2 = getPool(cfg);
		assert.notStrictEqual(p2, p1, "closePool() in one-shot mode must end the pool");
	});

	it("AC-5 one-shot mode: getPool() with changed signature creates a fresh pool", () => {
		const cfgA = { host: "127.0.0.1", port: 5432, user: "test-user-d", database: "test-db" };
		const cfgB = { host: "127.0.0.1", port: 5432, user: "test-user-d-different", database: "test-db" };

		const p1 = getPool(cfgA);
		const p2 = getPool(cfgB);
		assert.notStrictEqual(p2, p1, "signature change in one-shot mode must replace the pool");
	});

	it("mode transition: shutdown handler pattern works (long-running → one-shot → closePool)", async () => {
		const cfg = { host: "127.0.0.1", port: 5432, user: "test-user-e", database: "test-db" };
		const p1 = getPool(cfg);

		setPoolLifecycleMode("long-running");
		await closePool(); // no-op

		// Service shutdown path: drop back to one-shot, then closePool actually ends.
		setPoolLifecycleMode("one-shot");
		await closePool();

		const p2 = getPool(cfg);
		assert.notStrictEqual(p2, p1, "post-shutdown getPool() must be a fresh pool");
	});
});
