/**
 * Tests for the permissive-fallback path in resolveAgency. We mock the query
 * function so we can simulate (a) the strict-filter query returning 0 rows
 * and (b) the fallback query returning a candidate.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
	_setQueryForTest,
	_setResolverLoggerForTest,
	resolveAgency,
} from "./agency-resolver.ts";

interface RecordedCall {
	sql: string;
	params: unknown[];
}

function setupQuery(
	resultsInOrder: Array<Array<Record<string, unknown>>>,
): RecordedCall[] {
	const calls: RecordedCall[] = [];
	let i = 0;
	_setQueryForTest((async (sql: string, params?: unknown[]) => {
		calls.push({ sql, params: params ?? [] });
		const rows = resultsInOrder[i++] ?? [];
		return { rows };
	}) as never);
	return calls;
}

function silentLogger(): { messages: string[]; logger: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } } {
	const messages: string[] = [];
	return {
		messages,
		logger: {
			log: (..._a: unknown[]) => {},
			warn: (...a: unknown[]) => {
				messages.push(a.map((x) => String(x)).join(" "));
			},
		},
	};
}

const sampleRow = {
	id: 1,
	agency_id: 100,
	project_id: null,
	capabilities: {},
	status: "active",
	throttle_count: 0,
	last_seen_at: new Date(),
	max_in_flight: 4,
	in_flight_count: 0,
};

test("resolveAgency: capability filter matches → no fallback fires", async () => {
	const calls = setupQuery([[sampleRow]]);
	const log = silentLogger();
	_setResolverLoggerForTest(log.logger);

	const result = await resolveAgency("1", "developer", undefined, ["develop"]);

	assert.ok(result);
	assert.equal(result!.id, 1n);
	assert.equal(calls.length, 1, "no second query when first returns rows");
	assert.equal(log.messages.length, 0, "no fallback warning");
});

test("resolveAgency: capability filter returns 0 → permissive fallback fires + warns", async () => {
	const calls = setupQuery([
		[], // strict cap query: 0 rows
		[sampleRow], // fallback (no cap filter): 1 row
	]);
	const log = silentLogger();
	_setResolverLoggerForTest(log.logger);

	const result = await resolveAgency("1", "developer", undefined, ["develop"]);

	assert.ok(result);
	assert.equal(result!.id, 1n);
	assert.equal(calls.length, 2, "two queries: strict then permissive");
	// Strict query should mention the capability filter; fallback should not.
	assert.match(calls[0].sql, /pr\.capabilities->'jobs' \?/);
	assert.doesNotMatch(calls[1].sql, /pr\.capabilities->'jobs' \?/);
	assert.equal(log.messages.length, 1, "fallback emits exactly one warn");
	assert.match(log.messages[0], /permissive fallback fired/);
	// Result tags itself so callers can distinguish.
	assert.equal(
		(result!.capabilities as { _resolved_via?: string })._resolved_via,
		"permissive-fallback",
	);
});

test("resolveAgency: 0 rows in both passes → null", async () => {
	const calls = setupQuery([[], []]);
	const log = silentLogger();
	_setResolverLoggerForTest(log.logger);

	const result = await resolveAgency("1", "developer", undefined, ["develop"]);

	assert.equal(result, null);
	assert.equal(calls.length, 2);
	assert.equal(log.messages.length, 0, "no warn when fallback also fails");
});

test("resolveAgency: no requiredCapabilities → no fallback path attempted", async () => {
	const calls = setupQuery([[]]);
	const log = silentLogger();
	_setResolverLoggerForTest(log.logger);

	const result = await resolveAgency("1", "developer");

	assert.equal(result, null);
	assert.equal(calls.length, 1, "no fallback when there was no cap filter to relax");
	assert.equal(log.messages.length, 0);
});
