/**
 * P404: Unit tests for WriteGuard.
 *
 * WriteGuard prevents agent scratch processes from accidentally writing to
 * source-controlled directories.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { assertScratchWrite } from "../../src/shared/utils/write-guard.ts";

describe("assertScratchWrite", () => {
	it("throws for a path inside src/", () => {
		assert.throws(
			() => assertScratchWrite("src/foo.ts"),
			/WriteGuard.*blocked/,
		);
	});

	it("throws for a path inside docs/", () => {
		assert.throws(
			() => assertScratchWrite("docs/architecture/overview.md"),
			/WriteGuard.*blocked/,
		);
	});

	it("throws for a path inside scripts/", () => {
		assert.throws(
			() => assertScratchWrite("scripts/build.sh"),
			/WriteGuard.*blocked/,
		);
	});

	it("throws for a path inside tests/", () => {
		assert.throws(
			() => assertScratchWrite("tests/unit/example.test.ts"),
			/WriteGuard.*blocked/,
		);
	});

	it("does NOT throw with optIn=true for a protected path", () => {
		assert.doesNotThrow(() =>
			assertScratchWrite("src/foo.ts", { optIn: true }),
		);
	});

	it("does NOT throw for a path inside /tmp/agenthive/", () => {
		assert.doesNotThrow(() =>
			assertScratchWrite("/tmp/agenthive/550e8400-e29b-41d4-a716-446655440000/output.txt"),
		);
	});

	it("does NOT throw for an unrelated path", () => {
		assert.doesNotThrow(() => assertScratchWrite("/var/log/app.log"));
	});
});
