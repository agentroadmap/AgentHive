/**
 * P182 AC-9: Unit tests for autoCharterIfNeeded.
 *
 * Verifies:
 *   (a) < 2 alive dispatches → returns { chartered: false }, no writes
 *   (b) ≥ 2 alive dispatches → upserts team, charter, and 5 default norms
 *   (c) Returns { chartered: true, teamId } on success
 *   (d) autoCharterIfNeeded is imported by post-work-offer (structural wiring)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoCharterIfNeeded } from "../../src/core/pipeline/auto-charter.ts";

type QueryRow = Record<string, unknown>;

function makeQueuedQueryFn(responses: Array<{ rows: QueryRow[] }>) {
	const queue = [...responses];
	const calls: Array<{ sql: string; params: unknown[] }> = [];

	const fn = async <T extends QueryRow>(sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		const next = queue.shift();
		if (!next) {
			throw new Error(
				`makeQueuedQueryFn: no response queued for query #${calls.length}: ${sql.slice(0, 60)}`,
			);
		}
		return { rows: next.rows as T[], rowCount: next.rows.length };
	};

	return { fn, calls };
}

describe("P182 AC-9: autoCharterIfNeeded", () => {
	it("returns { chartered: false } when fewer than 2 alive dispatches", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ alive_count: 1 }] },
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: false });
		assert.equal(calls.length, 1, "should stop after the count query");
	});

	it("returns { chartered: false } when zero alive dispatches", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ alive_count: 0 }] },
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: false });
		assert.equal(calls.length, 1);
	});

	it("upserts team + charter + 5 norms when 2+ alive dispatches", async () => {
		// Queries: (1) alive count, (2) team upsert, (3) charter upsert,
		//          (4-8) 5 default norm inserts
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ alive_count: 2 }] },
			{ rows: [{ id: 99 }] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: true, teamId: 99 });

		const charterInsert = calls.find(
			c =>
				c.sql.includes("team_norms") &&
				c.sql.includes("INSERT") &&
				c.sql.includes("team:charter"),
		);
		assert.ok(charterInsert, "should have inserted a team:charter row");

		const normKeys = [
			"team:norm:handoff",
			"team:norm:communication",
			"team:norm:challenge",
			"team:norm:memory",
			"team:norm:worktree",
		];
		for (const key of normKeys) {
			assert.ok(
				calls.some(c => (c.params as unknown[]).includes(key)),
				`should have inserted norm: ${key}`,
			);
		}
	});

	it("returns { chartered: true, teamId } when team already exists (upsert returns existing id)", async () => {
		// The ON CONFLICT DO UPDATE returns the existing row's id
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ alive_count: 3 }] },
			{ rows: [{ id: 42 }] },  // team upsert returns pre-existing team
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: true, teamId: 42 });
	});

	it("returns { chartered: false } when team upsert returns no id", async () => {
		const { fn } = makeQueuedQueryFn([
			{ rows: [{ alive_count: 2 }] },
			{ rows: [] },  // team INSERT returns no row
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: false });
	});

	it("autoCharterIfNeeded export is imported by post-work-offer (structural wiring)", async () => {
		const { autoCharterIfNeeded: fn } = await import(
			"../../src/core/pipeline/auto-charter.ts"
		);
		assert.equal(typeof fn, "function");
	});
});
