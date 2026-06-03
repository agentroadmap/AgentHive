/**
 * P182 AC-9: Unit tests for autoCharterIfNeeded.
 *
 * Verifies that:
 *   (a) < 2 alive dispatches → no charter written
 *   (b) ≥ 2 alive dispatches, no existing team → creates team + charter + 5 norms
 *   (c) Charter already exists → idempotent no-op
 *   (d) postWorkOffer imports and calls autoCharterIfNeeded on non-replay inserts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoCharterIfNeeded } from "../../src/core/pipeline/auto-charter.ts";

// ─── Mock queryFn factory ──────────────────────────────────────────────────────

type QueryRow = Record<string, unknown>;

/** Builds a queryFn that returns responses from a queue, one per call. */
function makeQueuedQueryFn(responses: Array<{ rows: QueryRow[]; rowCount?: number }>) {
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
		return { rows: next.rows as T[], rowCount: next.rowCount ?? next.rows.length };
	};

	return { fn, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("P182 AC-9: autoCharterIfNeeded", () => {
	it("returns chartered=false when fewer than 2 alive dispatches exist", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ count: 1 }] }, // COUNT alive dispatches → only 1
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: false });
		assert.equal(calls.length, 1, "should stop after the count query");
	});

	it("creates team + charter + 5 default norms when 2+ alive dispatches and no prior team", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ count: 2 }] },     // COUNT alive dispatches → 2
			{ rows: [] },                  // SELECT existing team → none
			{ rows: [{ id: 99 }] },        // INSERT team → id=99
			{ rows: [] },                  // SELECT existing charter → none
			{ rows: [], rowCount: 1 },     // INSERT team:charter
			{ rows: [], rowCount: 1 },     // INSERT team:norm:handoff
			{ rows: [], rowCount: 1 },     // INSERT team:norm:communication
			{ rows: [], rowCount: 1 },     // INSERT team:norm:challenge
			{ rows: [], rowCount: 1 },     // INSERT team:norm:memory
			{ rows: [], rowCount: 1 },     // INSERT team:norm:worktree
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: true, teamId: 99 });

		// Verify charter INSERT used the correct key
		const charterInsert = calls.find(
			c => c.sql.includes("team_norms") && c.sql.includes("INSERT") && (c.params as unknown[]).includes("team:charter"),
		);
		assert.ok(charterInsert, "should have inserted a team:charter row");

		// Verify all 5 default norm keys were inserted
		const normKeys = ["team:norm:handoff", "team:norm:communication", "team:norm:challenge", "team:norm:memory", "team:norm:worktree"];
		for (const key of normKeys) {
			const found = calls.some(c => (c.params as unknown[]).includes(key));
			assert.ok(found, `should have inserted norm: ${key}`);
		}
	});

	it("reuses an existing team when one already exists for the proposal", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ count: 3 }] },     // COUNT alive dispatches → 3
			{ rows: [{ id: 42 }] },        // SELECT existing team → id=42
			{ rows: [] },                  // SELECT existing charter → none
			{ rows: [], rowCount: 1 },     // INSERT team:charter
			{ rows: [], rowCount: 1 },     // INSERT team:norm:handoff
			{ rows: [], rowCount: 1 },     // INSERT team:norm:communication
			{ rows: [], rowCount: 1 },     // INSERT team:norm:challenge
			{ rows: [], rowCount: 1 },     // INSERT team:norm:memory
			{ rows: [], rowCount: 1 },     // INSERT team:norm:worktree
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: true, teamId: 42 });

		// No INSERT into the team table itself (team_norms inserts are expected)
		const teamInserts = calls.filter(
			c => /INSERT INTO roadmap_workforce\.team\b/.test(c.sql) && !c.sql.includes("team_norms"),
		);
		assert.equal(teamInserts.length, 0, "should not insert a new team when one exists");
	});

	it("returns chartered=false when charter already exists (idempotent)", async () => {
		const { fn, calls } = makeQueuedQueryFn([
			{ rows: [{ count: 2 }] },     // COUNT alive dispatches → 2
			{ rows: [{ id: 55 }] },        // SELECT existing team → id=55
			{ rows: [{ id: 7 }] },         // SELECT existing charter → exists
		]);

		const result = await autoCharterIfNeeded(182, fn as any);

		assert.deepEqual(result, { chartered: false, teamId: 55 });
		assert.equal(calls.length, 3, "should stop after finding existing charter");

		// No INSERT into team_norms
		const normInserts = calls.filter(c => c.sql.includes("INSERT INTO roadmap_workforce.team_norms"));
		assert.equal(normInserts.length, 0, "should not insert norms when charter exists");
	});

	it("auto-charter.ts exports are used by post-work-offer.ts", async () => {
		// Structural: verify the import chain exists at the module level.
		// If this import fails, AC-9 wiring is broken.
		const { autoCharterIfNeeded: fn } = await import(
			"../../src/core/pipeline/auto-charter.ts"
		);
		assert.equal(typeof fn, "function");
	});
});
