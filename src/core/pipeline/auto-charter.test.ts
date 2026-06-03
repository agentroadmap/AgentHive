/**
 * AC-9 (P182): integration-style unit tests for autoCharterIfNeeded.
 *
 * Pure-mocked — no live DB. Verifies:
 *   - When 2+ alive squad_dispatch rows exist for a proposal, a team row is
 *     created and team:charter + 5 default norms are upserted into team_norms.
 *   - When only 1 alive dispatch exists, no team or charter is created.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { autoCharterIfNeeded } from "./auto-charter.ts";
import type { QueryFn } from "./post-work-offer.ts";

interface RecordingQuery {
	calls: Array<{ sql: string; params: unknown[] }>;
	fn: QueryFn;
}

/**
 * Build a mock queryFn backed by a scripted result sequence.
 * Each element of scriptedRows is the `rows` array returned for that call.
 */
function makeQuery(
	scriptedRows: Array<Array<Record<string, unknown>>>,
): RecordingQuery {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	let i = 0;
	const fn: QueryFn = (async (sql: string, params?: unknown[]) => {
		calls.push({ sql, params: params ?? [] });
		const rows = scriptedRows[i++] ?? [];
		return { rows } as never;
	}) as never;
	return { calls, fn };
}

test("autoCharterIfNeeded: 2 alive dispatches → creates team + charter + 5 default norms", async () => {
	// Scripted responses in query order:
	// 1. alive_count query → 2 alive rows
	// 2. team INSERT (find-or-create) → new team id=42
	// 3. team_norms INSERT team:charter → (no rows needed)
	// 4–8. five default norm INSERTs → (no rows needed)
	const { calls, fn } = makeQuery([
		[{ alive_count: 2 }],  // count query
		[{ id: 42 }],          // team find-or-create
		[],                    // team:charter upsert
		[], [], [], [], [],    // 5 default norms
	]);

	await autoCharterIfNeeded(182, fn);

	// Verify alive-count query targeted squad_dispatch with correct proposal_id
	assert.equal(calls.length, 8, "expected 8 queries: 1 count + 1 team + 1 charter + 5 norms");
	assert.match(calls[0].sql, /squad_dispatch/);
	assert.deepEqual(calls[0].params, [182]);

	// Verify team find-or-create used correct team_name and type
	const teamSql = calls[1].sql;
	assert.match(teamSql, /INSERT INTO roadmap_workforce\.team/);
	assert.match(teamSql, /ON CONFLICT \(team_name\)/);
	assert.ok(
		(calls[1].params as string[]).includes("P182-squad"),
		"team_name must be P182-squad",
	);

	// Verify team:charter upsert targeted team_id=42
	const charterSql = calls[2].sql;
	assert.match(charterSql, /INSERT INTO roadmap_workforce\.team_norms/);
	assert.match(charterSql, /team:charter/);
	assert.deepEqual((calls[2].params as unknown[])[0], 42);

	// Verify 5 default norm INSERTs all target team_id=42
	const normKeys = calls.slice(3).map((c) => c.params[1]);
	assert.deepEqual(normKeys.sort(), [
		"team:norm:challenge",
		"team:norm:communication",
		"team:norm:handoff",
		"team:norm:memory",
		"team:norm:worktree",
	]);
});

test("autoCharterIfNeeded: 1 alive dispatch → no team or charter created", async () => {
	const { calls, fn } = makeQuery([
		[{ alive_count: 1 }], // count query returns only 1
	]);

	await autoCharterIfNeeded(182, fn);

	assert.equal(calls.length, 1, "only the count query should run when alive < 2");
	assert.match(calls[0].sql, /squad_dispatch/);
});

test("autoCharterIfNeeded: 0 alive dispatches → no team or charter created", async () => {
	const { calls, fn } = makeQuery([[{ alive_count: 0 }]]);

	await autoCharterIfNeeded(999, fn);

	assert.equal(calls.length, 1);
});

test("autoCharterIfNeeded: existing team returned by conflict → reuses team id, upserts charter", async () => {
	// ON CONFLICT (team_name) DO UPDATE returns existing id=77
	const { calls, fn } = makeQuery([
		[{ alive_count: 3 }],  // 3 alive dispatches
		[{ id: 77 }],          // conflict path: returns existing team id
		[],                    // team:charter upsert
		[], [], [], [], [],    // 5 default norms
	]);

	await autoCharterIfNeeded(5, fn);

	assert.equal(calls.length, 8);
	assert.deepEqual((calls[2].params as unknown[])[0], 77, "charter should target existing team 77");
});
