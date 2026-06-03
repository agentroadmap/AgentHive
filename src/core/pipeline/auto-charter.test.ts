/**
 * P182 AC-9 integration test: autoCharterIfNeeded
 *
 * Verifies that when 2+ alive squad_dispatch rows exist for a proposal,
 * autoCharterIfNeeded creates a team row and writes a team:charter norm plus
 * 5 default governance norms into team_norms.
 *
 * Pure-mocked: no DB. The scripted query responses simulate the sequence of
 * SQL calls the function makes.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { autoCharterIfNeeded } from "./auto-charter.ts";
import type { QueryFn } from "./post-work-offer.ts";

interface RecordedCall {
	sql: string;
	params: unknown[];
}

function makeQuery(scriptedRows: Array<Array<Record<string, unknown>>>): {
	calls: RecordedCall[];
	queryFn: QueryFn;
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const queryFn: QueryFn = (async (sql: string, params?: unknown[]) => {
		calls.push({ sql, params: params ?? [] });
		const rows = scriptedRows[i++] ?? [];
		return { rows } as never;
	}) as never;
	return { calls, queryFn };
}

test("autoCharterIfNeeded: no-op when fewer than 2 alive dispatches", async () => {
	const { calls, queryFn } = makeQuery([[{ count: 1 }]]);
	const result = await autoCharterIfNeeded(42, queryFn);
	assert.equal(result.chartered, false);
	assert.equal(result.teamId, undefined);
	// Only the alive-count query should have fired.
	assert.equal(calls.length, 1);
	assert.match(calls[0].sql, /squad_dispatch/);
});

test("autoCharterIfNeeded: no-op when 0 alive dispatches", async () => {
	const { calls, queryFn } = makeQuery([[{ count: 0 }]]);
	const result = await autoCharterIfNeeded(99, queryFn);
	assert.equal(result.chartered, false);
	assert.equal(calls.length, 1);
});

test("autoCharterIfNeeded: charters new team when 2+ alive dispatches, no prior team", async () => {
	// Query sequence:
	// 1. alive-count → 2
	// 2. existing team lookup → empty (no prior team)
	// 3. INSERT team → returns id=77
	// 4. existing charter lookup → empty
	// 5. INSERT team:charter norm
	// 6–10. INSERT 5 default norms (team:norm:handoff, etc.)
	const { calls, queryFn } = makeQuery([
		[{ count: 2 }],          // alive dispatches
		[],                      // no existing team
		[{ id: 77 }],            // new team id
		[],                      // no existing charter
		[],                      // charter INSERT
		[], [], [], [], [],      // 5 default norm INSERTs
	]);

	const result = await autoCharterIfNeeded(182, queryFn);

	assert.equal(result.chartered, true);
	assert.equal(result.teamId, 77);

	// Charter INSERT should target team_norms with norm_key='team:charter'
	const charterCall = calls.find(
		(c) => c.sql.includes("team_norms") && c.params.includes("team:charter"),
	);
	assert.ok(charterCall, "expected a team:charter norm INSERT");

	// 5 default norm inserts
	const normCalls = calls.filter(
		(c) =>
			c.sql.includes("team_norms") &&
			Array.isArray(c.params) &&
			c.params.some(
				(p) => typeof p === "string" && p.startsWith("team:norm:"),
			),
	);
	assert.equal(normCalls.length, 5, "expected 5 default norm INSERTs");
});

test("autoCharterIfNeeded: no-op when team + charter already exist", async () => {
	// Query sequence:
	// 1. alive-count → 3
	// 2. existing team lookup → id=77
	// 3. existing charter lookup → id=5 (charter exists)
	const { calls, queryFn } = makeQuery([
		[{ count: 3 }],
		[{ id: 77 }],
		[{ id: 5 }],
	]);

	const result = await autoCharterIfNeeded(182, queryFn);

	assert.equal(result.chartered, false);
	assert.equal(result.teamId, 77);

	// No norm INSERTs — charter already existed.
	const normInserts = calls.filter(
		(c) => c.sql.includes("team_norms") && c.sql.includes("INSERT"),
	);
	assert.equal(normInserts.length, 0, "must not re-insert norms when charter exists");
});

test("autoCharterIfNeeded: reuses existing team when one already exists", async () => {
	// Existing team found — no team INSERT, but charter is new.
	const { calls, queryFn } = makeQuery([
		[{ count: 2 }],
		[{ id: 55 }],   // existing team
		[],             // no charter yet
		[],             // charter INSERT
		[], [], [], [], [], // 5 default norms
	]);

	const result = await autoCharterIfNeeded(42, queryFn);
	assert.equal(result.chartered, true);
	assert.equal(result.teamId, 55);

	// No team INSERT should appear.
	const teamInsert = calls.find(
		(c) =>
			c.sql.includes("INSERT") &&
			c.sql.includes("roadmap_workforce.team") &&
			!c.sql.includes("team_norms"),
	);
	assert.equal(teamInsert, undefined, "must not INSERT a new team when one already exists");
});
