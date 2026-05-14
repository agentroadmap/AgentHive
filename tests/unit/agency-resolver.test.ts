import assert from "node:assert/strict";
import { test } from "node:test";

// Track all query calls
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let mockRows: Record<string, unknown>[] = [];

const {
	resolveAgency,
	recordSpawnFailure,
	recordCheckIn,
	scanAndTransitionSilentAgencies,
	resumeAgencyProviderLiaison,
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
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("throttle_count"));
	assert.ok(sql.includes("recent_failure_count"));
	assert.ok(sql.includes("last_failure_at"));
});

test("recordSpawnFailure transitions to throttled at threshold (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordSpawnFailure(42n);
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("throttled"));
	const params = queryCalls.at(-1)!.params;
	assert.equal(params[0], 42n);
	assert.equal(params[1], THROTTLE_THRESHOLD);
});

test("recordCheckIn resets status from throttled/dormant (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("throttled"));
	assert.ok(sql.includes("dormant"));
	assert.ok(sql.includes("active"));
});

test("recordCheckIn joins via agent_registry to match TEXT identity (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("agent_registry"));
	assert.ok(sql.includes("agent_identity"));
});

test("recordCheckIn decays recent_failure_count (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("recent_failure_count"));
});

// P765 AC-1: offline → dormant auto-recovery
test("recordCheckIn allows offline→dormant transition (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(0)!.sql;
	assert.ok(sql.includes("offline"), "must handle offline status in CASE");
	assert.ok(
		sql.includes("dormant"),
		"must transition offline→dormant on check-in",
	);
	assert.ok(
		!sql.includes("NOT IN ('offline'") && !sql.includes("NOT IN ('offline', 'retired')"),
		"must NOT exclude offline from WHERE clause",
	);
});

test("recordCheckIn clears offline_alerted_at on recovery (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(0)!.sql;
	assert.ok(sql.includes("offline_alerted_at"), "must clear alert flag on recovery");
	assert.ok(sql.includes("offline_since_at"), "must clear episode timestamp on recovery");
});

// P765 AC-3/AC-5: liveness scan transitions
test("scanAndTransitionSilentAgencies marks active→offline after 30 min (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await scanAndTransitionSilentAgencies();
	const sqls = queryCalls.map((c) => c.sql);
	const offlineSql = sqls.find((s) => s.includes("'offline'") && s.includes("30 minutes"));
	assert.ok(offlineSql, "must transition to offline after 30 min silence");
	assert.ok(offlineSql!.includes("offline_since_at"), "must record offline_since_at timestamp");
});

test("scanAndTransitionSilentAgencies marks active→dormant after 5 min (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await scanAndTransitionSilentAgencies();
	const sqls = queryCalls.map((c) => c.sql);
	const dormantSql = sqls.find((s) => s.includes("'dormant'") && s.includes("5 minutes"));
	assert.ok(dormantSql, "must transition to dormant after 5 min silence");
});

// P765 AC-2: operator resume
test("resumeAgencyProviderLiaison resets offline and throttle state (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await resumeAgencyProviderLiaison("claude-opus");
	const sqls = queryCalls.map((c) => c.sql);
	assert.ok(sqls.length >= 2, "must issue at least two queries (update + notify)");
	const updateSql = sqls.find((s) => s.includes("offline_alerted_at") || s.includes("offline_since_at"));
	assert.ok(updateSql, "must clear offline tracking columns");
	assert.ok(
		sqls.some((s) => s.includes("'retired'")),
		"must exclude retired agencies from resume",
	);
});
