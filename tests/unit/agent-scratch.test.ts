/**
 * P404: Unit tests for agent-scratch utilities.
 *
 * These tests use real filesystem operations on /tmp/ and mock the DB query
 * by overriding the module-level query import via test doubles.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdir, rm, stat, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";

import {
	SCRATCH_ROOT,
	UUID_RE,
	reapScratch,
} from "../../src/shared/utils/agent-scratch.ts";

// ─── UUID_RE validation ───────────────────────────────────────────────────────

describe("UUID_RE", () => {
	it("accepts a valid lowercase UUID", () => {
		assert.ok(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000"));
	});

	it("rejects an uppercase UUID", () => {
		assert.ok(!UUID_RE.test("550E8400-E29B-41D4-A716-446655440000"));
	});

	it("rejects a path traversal string", () => {
		assert.ok(!UUID_RE.test("../../../etc/passwd"));
	});

	it("rejects empty string", () => {
		assert.ok(!UUID_RE.test(""));
	});
});

// ─── reapScratch path-traversal guard ────────────────────────────────────────

describe("reapScratch", () => {
	it("throws on path traversal UUID", async () => {
		await assert.rejects(
			() => reapScratch("../../../etc/passwd"),
			/path traversal rejected/,
		);
	});

	it("throws on empty string UUID", async () => {
		await assert.rejects(() => reapScratch(""), /path traversal rejected/);
	});

	it("dryRun=true skips filesystem removal", async () => {
		const uuid = randomUUID();
		const dirPath = `${SCRATCH_ROOT}/${uuid}`;
		await mkdir(dirPath, { recursive: true, mode: 0o700 });

		// dryRun should leave the directory intact (no DB call either, so no error)
		await reapScratch(uuid, { dryRun: true });

		// directory should still exist
		await assert.doesNotReject(() => access(dirPath, constants.F_OK));

		// cleanup
		await rm(dirPath, { recursive: true, force: true });
	});

	it("is ENOENT-safe when directory does not exist", async () => {
		const uuid = randomUUID();
		// Do NOT create the directory — reapScratch should not throw
		// DB call will fail (no real DB), but the function catches that too
		await assert.doesNotReject(() => reapScratch(uuid));
	});
});

// ─── SCRATCH_ROOT constant ────────────────────────────────────────────────────

describe("SCRATCH_ROOT", () => {
	it("is the expected path", () => {
		assert.equal(SCRATCH_ROOT, "/tmp/agenthive");
	});
});
