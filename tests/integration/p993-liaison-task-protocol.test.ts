/**
 * P993 Integration Tests — Liaison Task Tracker
 *
 * AC-7: Concurrent claim conflict via partial unique index
 * AC-8: liaison_task_tracker row lifecycle (happy path structure)
 *
 * Pre-req: P993 migration 132 deployed.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { closePool, query } from "../../src/infra/postgres/pool.ts";

describe("P993 — Liaison Task Tracker", () => {
	beforeAll(async () => {
		// Ensure table exists (migration should have run)
		const { rows } = await query(
			`SELECT EXISTS(
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = 'roadmap' AND table_name = 'liaison_task_tracker'
			)`,
		);
		expect(rows[0].exists).toBe(true);
	});

	afterEach(async () => {
		await query(
			`DELETE FROM roadmap.liaison_task_tracker WHERE proposal_id LIKE 'P9993-test%'`,
		);
	});

	afterAll(async () => {
		await closePool();
	});

	describe("AC-1: Table structure", () => {
		it("should have the correct columns and constraints", async () => {
			const { rows } = await query(
				`SELECT column_name, data_type, is_nullable
				 FROM information_schema.columns
				 WHERE table_schema = 'roadmap' AND table_name = 'liaison_task_tracker'
				 ORDER BY ordinal_position`,
			);

			const names = (rows as any[]).map((r) => r.column_name);
			expect(names).toContain("task_id");
			expect(names).toContain("correlation_id");
			expect(names).toContain("proposal_id");
			expect(names).toContain("requestor_id");
			expect(names).toContain("liaison_id");
			expect(names).toContain("dispatch_id");
			expect(names).toContain("worker_identity");
			expect(names).toContain("status");
			expect(names).toContain("spawn_count");
			expect(names).toContain("last_status_at");
			expect(names).toContain("completed_at");
			expect(names).toContain("created_at");
		});

		it("should have status CHECK constraint", async () => {
			// Try to insert invalid status
			try {
				await query(
					`INSERT INTO roadmap.liaison_task_tracker
					    (correlation_id, proposal_id, requestor_id, liaison_id, status)
					 VALUES ($1, $2, $3, $4, $5)`,
					[
						"00000000-0000-0000-0000-000000000001",
						"P9993-test-check",
						"req-a",
						"liaison-a",
						"invalid_status",
					],
				);
				expect.fail("Should have thrown CHECK constraint violation");
			} catch (e: any) {
				expect(e.message).toMatch(/check/i);
			}
		});
	});

	describe("AC-7: Partial unique index prevents concurrent active tasks", () => {
		it("should allow two rows for same proposal when first is complete", async () => {
			const cid1 = "00000000-0000-0000-0000-000000000001";
			const cid2 = "00000000-0000-0000-0000-000000000002";

			await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)`,
				[cid1, "P9993-test-index", "req-a", "liaison-a", "complete"],
			);

			// Second row (pending) should succeed because first is 'complete' (excluded from partial index)
			await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)`,
				[cid2, "P9993-test-index", "req-b", "liaison-b", "pending"],
			);

			const { rows } = await query(
				`SELECT * FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
				["P9993-test-index"],
			);
			expect(rows).toHaveLength(2);
		});

		it("should reject second active row for same proposal (unique index violation)", async () => {
			const cid1 = "00000000-0000-0000-0000-000000000003";
			const cid2 = "00000000-0000-0000-0000-000000000004";

			await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)`,
				[cid1, "P9993-test-conflict", "req-a", "liaison-a", "pending"],
			);

			// Second row should fail due to unique index (both not in complete/failed)
			try {
				await query(
					`INSERT INTO roadmap.liaison_task_tracker
					    (correlation_id, proposal_id, requestor_id, liaison_id, status)
					 VALUES ($1, $2, $3, $4, $5)`,
					[cid2, "P9993-test-conflict", "req-b", "liaison-b", "in_progress"],
				);
				expect.fail("Should have thrown unique constraint violation");
			} catch (e: any) {
				expect(e.message).toMatch(/unique/i);
			}
		});

		it("should allow claimed→failed→new pending for same proposal", async () => {
			const cid1 = "00000000-0000-0000-0000-000000000005";
			const cid2 = "00000000-0000-0000-0000-000000000006";

			// Insert first task as claimed
			await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)`,
				[cid1, "P9993-test-retry", "req-a", "liaison-a", "claimed"],
			);

			// Mark as failed
			await query(
				`UPDATE roadmap.liaison_task_tracker SET status = $1 WHERE correlation_id = $2`,
				["failed", cid1],
			);

			// Now new pending should succeed (first is failed, excluded from partial index)
			await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)`,
				[cid2, "P9993-test-retry", "req-b", "liaison-b", "pending"],
			);

			const { rows } = await query(
				`SELECT * FROM roadmap.liaison_task_tracker WHERE proposal_id = $1 ORDER BY created_at`,
				["P9993-test-retry"],
			);
			expect(rows).toHaveLength(2);
		});
	});

	describe("AC-8: Status lifecycle", () => {
		it("should transition through pending → claimed → spawned → in_progress → complete", async () => {
			const cid = "00000000-0000-0000-0000-000000000007";

			const { rows: insertRows } = await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING task_id`,
				[cid, "P9993-test-lifecycle", "req-c", "liaison-c", "pending"],
			);

			const taskId = (insertRows[0] as any).task_id;

			// pending → claimed
			await query(
				`UPDATE roadmap.liaison_task_tracker SET status = $1 WHERE task_id = $2`,
				["claimed", taskId],
			);

			let row = await query(
				`SELECT status FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).status).toBe("claimed");

			// claimed → spawned
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET status = $1, dispatch_id = $2, worker_identity = $3
				 WHERE task_id = $4`,
				["spawned", 123, "worker-a", taskId],
			);

			row = await query(
				`SELECT status, dispatch_id FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).status).toBe("spawned");
			expect((row.rows[0] as any).dispatch_id).toBe(123);

			// spawned → in_progress
			await query(
				`UPDATE roadmap.liaison_task_tracker SET status = $1 WHERE task_id = $2`,
				["in_progress", taskId],
			);

			// in_progress → complete
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET status = $1, completed_at = now()
				 WHERE task_id = $2`,
				["complete", taskId],
			);

			row = await query(
				`SELECT status, completed_at FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).status).toBe("complete");
			expect((row.rows[0] as any).completed_at).not.toBeNull();
		});

		it("should track spawn_count and mark failed on exceed", async () => {
			const cid = "00000000-0000-0000-0000-000000000008";

			const { rows: insertRows } = await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status, spawn_count)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING task_id`,
				[cid, "P9993-test-spawn", "req-d", "liaison-d", "pending", 0],
			);

			const taskId = (insertRows[0] as any).task_id;

			// Increment spawn_count to 1
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET spawn_count = 1, last_status_at = now()
				 WHERE task_id = $1`,
				[taskId],
			);

			let row = await query(
				`SELECT spawn_count FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).spawn_count).toBe(1);

			// Increment to 2 and mark failed
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET spawn_count = 2, status = $1, last_status_at = now()
				 WHERE task_id = $2`,
				["failed", taskId],
			);

			row = await query(
				`SELECT spawn_count, status FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).spawn_count).toBe(2);
			expect((row.rows[0] as any).status).toBe("failed");
		});

		it("should set completed_at only for terminal states", async () => {
			const cid = "00000000-0000-0000-0000-000000000009";

			const { rows: insertRows } = await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING task_id`,
				[cid, "P9993-test-completed-at", "req-e", "liaison-e", "pending"],
			);

			const taskId = (insertRows[0] as any).task_id;

			// Non-terminal states
			await query(
				`UPDATE roadmap.liaison_task_tracker SET status = $1 WHERE task_id = $2`,
				["claimed", taskId],
			);

			let row = await query(
				`SELECT completed_at FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).completed_at).toBeNull();

			// Terminal: complete
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET status = $1, completed_at = now()
				 WHERE task_id = $2`,
				["complete", taskId],
			);

			row = await query(
				`SELECT completed_at FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);
			expect((row.rows[0] as any).completed_at).not.toBeNull();
		});
	});

	describe("AC-9: Timestamp tracking", () => {
		it("should maintain created_at and update last_status_at", async () => {
			const cid = "00000000-0000-0000-0000-000000000010";

			const before = new Date();
			const { rows: insertRows } = await query(
				`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING task_id, created_at, last_status_at`,
				[cid, "P9993-test-timestamps", "req-f", "liaison-f", "pending"],
			);

			const taskId = (insertRows[0] as any).task_id;
			const createdAt = new Date((insertRows[0] as any).created_at);
			const lastStatusAt1 = new Date((insertRows[0] as any).last_status_at);

			expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
			expect(lastStatusAt1.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

			// Wait a bit and update status
			await new Promise((r) => setTimeout(r, 100));

			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET status = $1, last_status_at = now()
				 WHERE task_id = $2`,
				["claimed", taskId],
			);

			const row = await query(
				`SELECT created_at, last_status_at FROM roadmap.liaison_task_tracker WHERE task_id = $1`,
				[taskId],
			);

			const createdAtAfter = new Date((row.rows[0] as any).created_at);
			const lastStatusAtAfter = new Date((row.rows[0] as any).last_status_at);

			// created_at should not change
			expect(createdAtAfter.getTime()).toBe(createdAt.getTime());

			// last_status_at should be newer
			expect(lastStatusAtAfter.getTime()).toBeGreaterThan(
				lastStatusAt1.getTime(),
			);
		});
	});
});
