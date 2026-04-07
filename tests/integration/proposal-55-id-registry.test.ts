/**
 * Tests for proposal-55: Proposal ID Registry
 * - Centralized ID allocation via daemon API
 * - ID range reservation per agent session
 * - Collision detection and recovery
 * - Audit trail logging
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IdRegistry } from "../../src/core/identity/id-registry.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-id-registry");

describe("proposal-55: Proposal ID Registry", () => {
	let testDir: string;
	let registry: IdRegistry;
	let testCounter = 0;

	beforeEach(() => {
		// Unique directory per test to avoid interference
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });
		registry = new IdRegistry(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("AC#1: Centralized ID allocation", () => {
		it("allocates a single ID", async () => {
			const result = await registry.allocateId({
				sessionId: "test-agent-1",
				prefix: "STATE",
			});

			assert.equal(result.ids.length, 1);
			assert.equal(result.ids[0], "proposal-1");
			assert.equal(result.rangeStart, 1);
			assert.ok(result.rangeEnd >= 1);
			assert.ok(result.timestamp);
		});

		it("allocates sequential IDs", async () => {
			const r1 = await registry.allocateId({
				sessionId: "agent-1",
				prefix: "STATE",
			});
			const r2 = await registry.allocateId({
				sessionId: "agent-2",
				prefix: "STATE",
			});

			assert.equal(r1.ids[0], "proposal-1");
			assert.equal(r2.ids[0], "proposal-2");
		});

		it("allocates multiple IDs at once", async () => {
			const result = await registry.allocateId({
				sessionId: "batch-agent",
				count: 5,
				prefix: "STATE",
			});

			assert.equal(result.ids.length, 5);
			assert.deepEqual(result.ids, [
				"proposal-1",
				"proposal-2",
				"proposal-3",
				"proposal-4",
				"proposal-5",
			]);
			assert.equal(result.rangeStart, 1);
			assert.equal(result.rangeEnd, 5);
		});

		it("uses STATE prefix by default", async () => {
			const result = await registry.allocateId({
				sessionId: "test",
			});

			assert.ok(/^proposal-\d+$/.test(result.ids[0]!));
		});

		it("supports custom prefixes", async () => {
			const result = await registry.allocateId({
				sessionId: "draft-agent",
				prefix: "DRAFT",
			});

			assert.equal(result.ids[0], "draft-1");
		});
	});

	describe("AC#2: ID range reservation per session", () => {
		it("reserves a range for the session", async () => {
			await registry.allocateId({
				sessionId: "session-1",
				count: 1,
				prefix: "STATE",
			});

			const status = registry.getStatus();
			assert.equal(status.reservedRanges.length, 1);
			assert.equal(status.reservedRanges[0]?.sessionId, "session-1");
			assert.ok(status.reservedRanges[0]?.expiresAt);
		});

		it("releases reservations for a session", async () => {
			await registry.allocateId({
				sessionId: "session-1",
				count: 3,
				prefix: "STATE",
			});

			await registry.releaseRange("session-1");

			const status = registry.getStatus();
			assert.equal(status.reservedRanges.length, 0);
		});

		it("allocates new range after release", async () => {
			// Allocate 3 IDs
			const r1 = await registry.allocateId({
				sessionId: "session-1",
				count: 3,
				prefix: "STATE",
			});
			assert.deepEqual(r1.ids, ["proposal-1", "proposal-2", "proposal-3"]);

			// Release
			await registry.releaseRange("session-1");

			// New allocation should continue from next available
			const r2 = await registry.allocateId({
				sessionId: "session-2",
				count: 1,
				prefix: "STATE",
			});
			assert.equal(r2.ids[0], "proposal-4");
		});

		it("reserves range prevents overlap", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				count: 5,
				prefix: "STATE",
			});

			const r2 = await registry.allocateId({
				sessionId: "agent-2",
				count: 1,
				prefix: "STATE",
			});

			// Should allocate after the reserved range
			assert.ok(r2.rangeStart >= 6);
		});
	});

	describe("AC#3: Collision detection and recovery", () => {
		it("detects collision with reserved ID", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				count: 5,
				prefix: "STATE",
			});

			const collision = await registry.checkCollision("proposal-3");
			assert.equal(collision.exists, true);
			assert.equal(collision.reason, "reserved");
		});

		it("returns no collision for unallocated ID", async () => {
			const collision = await registry.checkCollision("proposal-999");
			assert.equal(collision.exists, false);
		});

		it("returns no collision for invalid ID format", async () => {
			const collision = await registry.checkCollision("invalid-id");
			assert.equal(collision.exists, false);
		});

		it("detects collision with allocated ID", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				prefix: "STATE",
			});

			// Wait a tick to ensure allocation completes
			await new Promise((r) => setTimeout(r, 10));

			// The allocated ID is logged (but may still be in reserved range)
			const collision = await registry.checkCollision("proposal-1");
			assert.equal(collision.exists, true);
		});
	});

	describe("AC#4: Audit trail logging", () => {
		it("logs allocations", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				prefix: "STATE",
			});
			await registry.allocateId({
				sessionId: "agent-2",
				prefix: "STATE",
			});

			const log = registry.getAuditLog();
			assert.equal(log.length, 2);
			assert.equal(log[0]?.id, "proposal-1");
			assert.equal(log[0]?.sessionId, "agent-1");
			assert.equal(log[1]?.id, "proposal-2");
			assert.equal(log[1].sessionId, "agent-2");
		});

		it("logs batch allocations", async () => {
			await registry.allocateId({
				sessionId: "batch",
				count: 3,
				prefix: "STATE",
			});

			const log = registry.getAuditLog();
			assert.equal(log.length, 3);
			assert.deepEqual(
				log.map((e) => e.id),
				["proposal-1", "proposal-2", "proposal-3"],
			);
		});

		it("respects log limit", async () => {
			for (let i = 0; i < 5; i++) {
				await registry.allocateId({
					sessionId: `agent-${i}`,
					prefix: "STATE",
				});
			}

			const log = registry.getAuditLog(3);
			assert.equal(log.length, 3);
			// Should be the last 3
			assert.equal(log[0].id, "proposal-3");
			assert.equal(log[2].id, "proposal-5");
		});

		it("includes timestamp in log entries", async () => {
			await registry.allocateId({
				sessionId: "test",
				prefix: "STATE",
			});

			const log = registry.getAuditLog();
			assert.ok(log[0].timestamp);
			assert.ok(new Date(log[0].timestamp).getTime() > 0);
		});
	});

	describe("Status reporting", () => {
		it("reports next ID", () => {
			const status = registry.getStatus();
			assert.equal(status.nextId, 1);
		});

		it("reports total allocations", async () => {
			await registry.allocateId({ sessionId: "a", prefix: "STATE" });
			await registry.allocateId({ sessionId: "b", count: 2, prefix: "STATE" });

			const status = registry.getStatus();
			assert.equal(status.totalAllocations, 3);
		});

		it("reports reserved ranges", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				count: 5,
				prefix: "STATE",
			});

			const status = registry.getStatus();
			assert.equal(status.reservedRanges.length, 1);
			assert.equal(status.reservedRanges[0].rangeStart, 1);
			assert.equal(status.reservedRanges[0].rangeEnd, 5);
		});
	});

	describe("Persistence", () => {
		it("persists proposal across instances", async () => {
			await registry.allocateId({
				sessionId: "agent-1",
				prefix: "STATE",
			});

			// Create new registry instance pointing to same directory
			const registry2 = new IdRegistry(testDir);

			const result = await registry2.allocateId({
				sessionId: "agent-2",
				prefix: "STATE",
			});

			assert.equal(result.ids[0], "proposal-2");
		});
	});
});
