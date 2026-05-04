import assert from "node:assert/strict";
import { test } from "node:test";

// Track all query calls
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let mockRows: Record<string, unknown>[] = [];

const {
	resolveAgency,
	recordSpawnFailure,
	recordCheckIn,
	THROTTLE_THRESHOLD,
	_setQueryForTest,
} = await import("../../src/core/orchestration/resolvers/agency-resolver.ts");

_setQueryForTest(async (sql: string, params: unknown[] = []) => {
	queryCalls.push({ sql, params });
	// biome-ignore lint/suspicious/noExplicitAny: test mock returns partial QueryResult shape
	return { rows: mockRows, rowCount: mockRows.length } as any;
});

test("THROTTLE_THRESHOLD is 3", () => {
	assert.equal(THROTTLE_THRESHOLD, 3);
});

test("resolveAgency returns null when no agencies available", async () => {
	mockRows = [];
	const result = await resolveAgency("project-1");
	assert.equal(result, null);
});

test("resolveAgency excludes offline and retired agencies (SQL check)", async () => {
	mockRows = [];
	await resolveAgency("project-1");
	const lastCall = queryCalls.at(-1);
	assert.ok(lastCall?.sql.includes("offline"));
	assert.ok(lastCall?.sql.includes("retired"));
});

test("resolveAgency filters by in-flight capacity (SQL check)", async () => {
	mockRows = [];
	await resolveAgency("project-1");
	const lastCall = queryCalls.at(-1);
	assert.ok(lastCall?.sql.includes("in_flight_count"));
	assert.ok(lastCall?.sql.includes("max_in_flight"));
});

test("resolveAgency returns candidate with expected shape", async () => {
	mockRows = [
		{
			id: "1",
			agency_id: "42",
			project_id: "project-1",
			capabilities: {},
			status: "active",
			throttle_count: 0,
			last_seen_at: new Date(),
			max_in_flight: 4,
			in_flight_count: "0",
		},
	];
	const result = await resolveAgency("project-1");
	assert.ok(result !== null);
	assert.equal(result.status, "active");
	assert.equal(typeof result.id, "bigint");
	assert.equal(typeof result.maxInFlight, "number");
	assert.equal(typeof result.inFlightCount, "number");
});

test("recordSpawnFailure increments throttle_count and recent_failure_count (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordSpawnFailure(42n);
	assert.ok(queryCalls.length > 0);
	const sql = queryCalls.at(-1)?.sql;
	assert.ok(sql.includes("throttle_count"));
	assert.ok(sql.includes("recent_failure_count"));
	assert.ok(sql.includes("last_failure_at"));
});

test("recordSpawnFailure transitions to throttled at threshold (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordSpawnFailure(42n);
	const sql = queryCalls.at(-1)?.sql;
	assert.ok(sql.includes("throttled"));
	const params = queryCalls.at(-1)?.params;
	assert.equal(params[0], 42n);
	assert.equal(params[1], THROTTLE_THRESHOLD);
});

test("recordCheckIn resets status from throttled/dormant (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)?.sql;
	assert.ok(sql.includes("throttled"));
	assert.ok(sql.includes("dormant"));
	assert.ok(sql.includes("active"));
});

test("recordCheckIn joins via agent_registry to match TEXT identity (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)?.sql;
	assert.ok(sql.includes("agent_registry"));
	assert.ok(sql.includes("agent_identity"));
});

test("recordCheckIn decays recent_failure_count (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)?.sql;
	assert.ok(sql.includes("recent_failure_count"));
});
