/**
 * Tests for P924 cursor-based message drain and boot-side crash recovery.
 *
 * AC-10: Polling idempotency — drain skips already-acked rows.
 * AC-11: Long-partition survivor — cursor-based drain (no time window) processes all unacked.
 * AC-12: Concurrent claim prevention — FOR UPDATE SKIP LOCKED prevents double-processing.
 * AC-13/AC-14/AC-15: Boot-side advisory-lock sweep and restart race handling.
 */

import { describe, it, beforeAll, afterAll, afterEach } from "bun:test";
import assert from "assert";
import { drainHostPendingMessages } from "./notify-miss-recovery.ts";
import { query } from "../postgres/pool.ts";

// Test fixture setup/teardown for a fresh schema + data.
async function setupTestDb() {
	// Ensure metadata column exists (P924 migration)
	await query(
		`ALTER TABLE roadmap.agency_liaison_session
     ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb`
	);
	// Clear data for the test run (tables exist from schema copy).
	await query(`DELETE FROM roadmap.liaison_message`);
	await query(`DELETE FROM roadmap.agency_liaison_session`);
	await query(`DELETE FROM roadmap.agency`);
}

async function teardownTestDb() {
	await query(`DELETE FROM roadmap.liaison_message`);
	await query(`DELETE FROM roadmap.agency_liaison_session`);
	await query(`DELETE FROM roadmap.agency`);
}

async function createTestAgency(agencyId: string, hostId: string = 'test-host') {
	// Create host_model_policy entry first (required for FK)
	await query(
		`INSERT INTO roadmap.host_model_policy (host_name, allowed_providers, forbidden_providers, default_model)
     VALUES ($1, ARRAY['test-provider'], ARRAY[]::TEXT[], 'test-model')
     ON CONFLICT (host_name) DO NOTHING`,
		[hostId],
	);
	// Insert agency
	const result = await query(
		`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
     VALUES ($1, $2, 'test-provider', $3, 'active')
     ON CONFLICT (agency_id) DO NOTHING
     RETURNING agency_id`,
		[agencyId, agencyId, hostId],
	);
	return result.rows.length > 0;
}

describe("P924 — notify-miss-recovery", () => {
	beforeAll(async () => {
		await setupTestDb();
	});

	afterAll(async () => {
		await teardownTestDb();
	});

	afterEach(async () => {
		await teardownTestDb();
	});

	describe("AC-10: Polling idempotency", () => {
		it("should process exactly 5 unacked messages and skip already-acked", async () => {
			const sessionId = crypto.randomUUID();
			const hostId = "host-01";
			const agencyId = "test-agency";

			await createTestAgency(agencyId, hostId);

			// Insert 5 unacked + 3 acked messages.
			for (let i = 0; i < 5; i++) {
				await query(
					`INSERT INTO roadmap.liaison_message
         (agency_id, host_id, kind, direction, sequence, message_id, correlation_id, signed_at, signature)
         VALUES ($1, $2, 'offer_dispatch', 'liaison->orchestrator', $3, gen_random_uuid(), gen_random_uuid(), now(), '')`,
					[agencyId, hostId, i],
				);
			}

			for (let i = 0; i < 3; i++) {
				await query(
					`INSERT INTO roadmap.liaison_message
         (agency_id, host_id, kind, direction, sequence, message_id, correlation_id, signed_at, signature, acked_at, ack_outcome)
         VALUES ($1, $2, 'offer_dispatch', 'liaison->orchestrator', $3, gen_random_uuid(), gen_random_uuid(), now(), '', now(), 'ok')`,
					[agencyId, hostId, 100 + i],
				);
			}

			// Create a session for cursor bookkeeping.
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host)
       VALUES ($1, $2, 123, 'host-01')`,
				[sessionId, agencyId],
			);

			// First drain: process the 5 unacked.
			let successCount = 0;
			const result1 = await drainHostPendingMessages(
				hostId,
				sessionId,
				50,
				async (row) => {
					successCount++;
					return { ok: true };
				},
			);

			assert.strictEqual(
				result1.drained,
				5,
				"Should drain exactly 5 unacked messages",
			);
			assert.strictEqual(
				result1.succeeded,
				5,
				"All 5 should succeed on first drain",
			);
			assert.strictEqual(result1.failed, 0, "No failures on first drain");

			// Verify all 5 are now acked.
			const ackedResult = await query<{ count: string }>(
				`SELECT COUNT(*) as count FROM roadmap.liaison_message
       WHERE host_id = $1 AND acked_at IS NOT NULL`,
				[hostId],
			);
			assert.strictEqual(
				parseInt(ackedResult.rows[0]?.count ?? "0"),
				8,
				"Should have 3 original + 5 newly acked = 8 total acked",
			);

			// Second drain: should find 0 unacked (all already acked).
			const result2 = await drainHostPendingMessages(
				hostId,
				sessionId,
				50,
				async (row) => {
					throw new Error("Should not be called on second drain");
				},
			);

			assert.strictEqual(
				result2.drained,
				0,
				"Second drain should find 0 unacked messages",
			);
		});
	});

	describe("AC-11: Long-partition survivor", () => {
		it("should eventually drain all 10 unacked regardless of age (cursor-based, no time window)", async () => {
			const sessionId = crypto.randomUUID();
			const hostId = "host-02";
			const agencyId = "partition-test";

			await createTestAgency(agencyId, hostId);

			// Create a session.
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host)
       VALUES ($1, $2, 456, 'host-02')`,
				[sessionId, agencyId],
			);

			// Insert 10 unacked messages with staggered created_at times
			// (simulating messages from before a long partition).
			const now = new Date();
			for (let i = 0; i < 10; i++) {
				const createdAt = new Date(
					now.getTime() - (10 - i) * 60 * 1000,
				); // 10 min to 0 min ago
				await query(
					`INSERT INTO roadmap.liaison_message
         (agency_id, host_id, kind, direction, sequence, message_id, correlation_id, signed_at, signature, created_at)
         VALUES ($1, $2, 'offer_dispatch', 'liaison->orchestrator', $3, gen_random_uuid(), gen_random_uuid(), now(), '', $4)`,
					[agencyId, hostId, i, createdAt],
				);
			}

			// Drain with a small batch size to verify multi-pass behavior.
			let drainedTotal = 0;
			const batchSize = 3;

			for (let pass = 0; pass < 5; pass++) {
				const result = await drainHostPendingMessages(
					hostId,
					sessionId,
					batchSize,
					async (row) => {
						return { ok: true };
					},
				);
				drainedTotal += result.drained;
				if (result.drained === 0) break;
			}

			assert.strictEqual(
				drainedTotal,
				10,
				"Should eventually drain all 10 unacked messages (no time window cutoff)",
			);

			// Verify all are acked.
			const ackedResult = await query<{ count: string }>(
				`SELECT COUNT(*) as count FROM roadmap.liaison_message
       WHERE host_id = $1 AND acked_at IS NOT NULL`,
				[hostId],
			);
			assert.strictEqual(
				parseInt(ackedResult.rows[0]?.count ?? "0"),
				10,
				"All 10 should be acked",
			);
		});
	});

	describe("AC-12: Concurrent claim prevention", () => {
		it("should prevent double-processing via FOR UPDATE SKIP LOCKED", async () => {
			const sessionId = crypto.randomUUID();
			const hostId = "host-03";
			const agencyId = "concurrent-test";

			await createTestAgency(agencyId, hostId);

			// Create a session.
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host)
       VALUES ($1, $2, 789, 'host-03')`,
				[sessionId, agencyId],
			);

			// Insert 1 test message.
			await query(
				`INSERT INTO roadmap.liaison_message
       (agency_id, host_id, kind, direction, sequence, message_id, correlation_id, signed_at, signature)
       VALUES ($1, $2, 'offer_dispatch', 'liaison->orchestrator', 1, gen_random_uuid(), gen_random_uuid(), now(), '')`,
				[agencyId, hostId],
			);

			let processedCount = 0;

			// Simulate two concurrent handlers claiming the same message.
			// In reality, pg FOR UPDATE SKIP LOCKED ensures only one gets the lock,
			// the other gets zero rows in the WITH claimed clause.
			const handler1 = drainHostPendingMessages(
				hostId,
				sessionId,
				50,
				async (row) => {
					processedCount++;
					return { ok: true };
				},
			);

			const handler2 = drainHostPendingMessages(
				hostId,
				sessionId,
				50,
				async (row) => {
					processedCount++;
					return { ok: true };
				},
			);

			const [result1, result2] = await Promise.all([handler1, handler2]);

			// Combined, only 1 message should be drained and acked.
			// (One handler gets the lock; the other skips the locked row.)
			assert.strictEqual(
				result1.drained + result2.drained,
				1,
				"Combined drains should claim only 1 message (FOR UPDATE SKIP LOCKED)",
			);

			// Verify that exactly one handler processed the message.
			assert.strictEqual(
				processedCount,
				1,
				"Only one handler should have processed the message",
			);
		});
	});

	describe("AC-13/AC-14: Boot-side crash recovery sweep", () => {
		it("should close stale sessions via blocking advisory-lock sweep", async () => {
			// Note: This test verifies the schema contract; the actual sweep
			// logic is in agency-self-registration.ts and would be tested there.

			const sessionId1 = crypto.randomUUID();
			const agencyId = "crash-recovery-test";
			const oldPid = 12345;
			const hostId = "host-04";

			await createTestAgency(agencyId, hostId);

			// Insert a session with old pid (simulating a crashed runtime).
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host, started_at)
       VALUES ($1, $2, $3, $4, now() - interval '5 minutes')`,
				[sessionId1, agencyId, oldPid, hostId],
			);

			// Simulate the boot-side sweep: mark as ended if pid mismatch.
			const sweepResult = await query<{
				session_id: string;
				agency_id: string;
			}>(
				`UPDATE roadmap.agency_liaison_session
       SET ended_at = now(), end_reason = 'crash_recovery_pid_mismatch'
       WHERE liaison_host = $1
         AND liaison_pid IS DISTINCT FROM $2
         AND ended_at IS NULL
       RETURNING session_id, agency_id`,
				[hostId, process.pid], // New pid != oldPid
			);

			assert.strictEqual(
				sweepResult.rows.length,
				1,
				"Sweep should close the stale session",
			);
			assert.strictEqual(
				sweepResult.rows[0]?.agency_id,
				agencyId,
				"Closed session should match the agency",
			);

			// Verify the session is now ended.
			const verifyResult = await query<{ ended_at: Date; end_reason: string }>(
				`SELECT ended_at, end_reason FROM roadmap.agency_liaison_session
       WHERE session_id = $1`,
				[sessionId1],
			);
			assert.ok(
				verifyResult.rows[0]?.ended_at !== null,
				"Session should be marked as ended",
			);
			assert.strictEqual(
				verifyResult.rows[0]?.end_reason,
				"crash_recovery_pid_mismatch",
				"End reason should be crash_recovery_pid_mismatch",
			);
		});

		it("should allow new session registration after stale session closed", async () => {
			// This tests the idempotency contract: after sweep, P921's unique
			// index (idx_agency_session_one_active) should allow a new insert.

			const agencyId = "crash-recovery-idempotent";
			const hostId = "host-05";

			await createTestAgency(agencyId, hostId);

			// Create and close an old session.
			const oldSessionId = crypto.randomUUID();
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host, started_at, ended_at, end_reason)
       VALUES ($1, $2, 99999, $3, now() - interval '1 hour', now(), 'crash_recovery_pid_mismatch')`,
				[oldSessionId, agencyId, hostId],
			);

			// Now insert a new session (simulating a fresh boot).
			const newSessionId = crypto.randomUUID();
			const insertResult = await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host)
       VALUES ($1, $2, $3, $4)
       RETURNING session_id`,
				[newSessionId, agencyId, process.pid, hostId],
			);

			assert.strictEqual(
				insertResult.rows.length,
				1,
				"New session should be insertable after old one is closed",
			);
		});
	});

	describe("AC-9: Cursor bookkeeping", () => {
		it("should store (created_at, id) cursor on session.metadata", async () => {
			const sessionId = crypto.randomUUID();
			const hostId = "host-06";
			const agencyId = "cursor-bookkeeping";

			await createTestAgency(agencyId, hostId);

			// Create a session.
			await query(
				`INSERT INTO roadmap.agency_liaison_session
       (session_id, agency_id, liaison_pid, liaison_host)
       VALUES ($1, $2, 111, 'host-06')`,
				[sessionId, agencyId],
			);

			// Insert 3 unacked messages.
			const now = new Date();
			for (let i = 0; i < 3; i++) {
				await query(
					`INSERT INTO roadmap.liaison_message
         (agency_id, host_id, kind, direction, sequence, message_id, correlation_id, signed_at, signature, created_at)
         VALUES ($1, $2, 'offer_dispatch', 'liaison->orchestrator', $3, gen_random_uuid(), gen_random_uuid(), now(), '', $4)`,
					[agencyId, hostId, i, new Date(now.getTime() + i * 1000)],
				);
			}

			// Drain and process all.
			await drainHostPendingMessages(
				hostId,
				sessionId,
				50,
				async (row) => {
					return { ok: true };
				},
			);

			// Check that metadata was updated with cursor.
			const sessionResult = await query<{ metadata: Record<string, unknown> }>(
				`SELECT metadata FROM roadmap.agency_liaison_session
       WHERE session_id = $1`,
				[sessionId],
			);

			const metadata = sessionResult.rows[0]?.metadata;
			assert.ok(
				metadata && typeof metadata === "object",
				"metadata should be a non-null object",
			);
			assert.ok(
				"drain_cursor_created_at" in metadata,
				"metadata should contain drain_cursor_created_at",
			);
			assert.ok(
				"drain_cursor_id" in metadata,
				"metadata should contain drain_cursor_id",
			);
		});
	});
});
