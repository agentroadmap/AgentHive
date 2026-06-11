import assert from "node:assert/strict";
import { test } from "node:test";

// Track all query calls
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let mockRows: Record<string, unknown>[] = [];

const notificationCalls: Array<Record<string, unknown>> = [];

const {
	resolveAgency,
	recordSpawnFailure,
	recordCheckIn,
	resumeAgency,
	scanAndAlertOfflineAgencies,
	THROTTLE_THRESHOLD,
	OFFLINE_ALERT_THRESHOLD_MINUTES,
	_setQueryForTest,
	_setNotificationForTest,
} = await import(
	"../../src/core/orchestration/resolvers/agency-resolver.ts"
);

_setQueryForTest(async (sql: string, params: unknown[] = []) => {
	queryCalls.push({ sql, params });
	// biome-ignore lint/suspicious/noExplicitAny: test mock returns partial QueryResult shape
	return { rows: mockRows, rowCount: mockRows.length } as any;
});

_setNotificationForTest(async (args: Record<string, unknown>) => {
	notificationCalls.push(args);
	return notificationCalls.length;
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

// ─── P765 AC-1: offline → dormant two-step recovery ───────────────────────

test("recordCheckIn AC-1: includes offline→dormant transition branch (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	// Must handle offline in a CASE branch
	assert.ok(sql.includes("offline"), "SQL should reference offline status");
	assert.ok(sql.includes("dormant"), "SQL should reference dormant status");
});

test("recordCheckIn AC-1: does NOT exclude offline from WHERE (only retired excluded)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	// The NOT IN exclusion must not include 'offline' — only 'retired'
	const notInMatch = sql.match(/NOT IN\s*\(([^)]+)\)/i)?.[1] ?? "";
	assert.ok(
		!notInMatch.includes("offline"),
		"offline must NOT be excluded by NOT IN",
	);
	assert.ok(
		notInMatch.includes("retired"),
		"retired must be excluded by NOT IN",
	);
});

test("recordCheckIn AC-1: resets throttle_count when coming from offline (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	// throttle_count reset CASE must include 'offline' alongside 'throttled'
	const throttleIdx = sql.indexOf("throttle_count");
	const throttleSection = sql.slice(throttleIdx, throttleIdx + 200);
	assert.ok(
		throttleSection.includes("offline"),
		"throttle reset CASE must cover offline",
	);
});

// ─── P765 AC-2: resumeAgency operator short-circuit ──────────────────────

test("resumeAgency AC-2: sets status=active and resets counters (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await resumeAgency("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("active"), "SQL must set status to active");
	assert.ok(sql.includes("throttle_count"), "SQL must reset throttle_count");
	assert.ok(
		sql.includes("recent_failure_count"),
		"SQL must reset recent_failure_count",
	);
	assert.ok(sql.includes("last_failure_at"), "SQL must clear last_failure_at");
});

test("resumeAgency AC-2: excludes retired agencies from update (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await resumeAgency("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("retired"), "SQL must exclude retired agencies");
});

test("resumeAgency AC-2: resolves identity via agent_registry (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await resumeAgency("claude-opus");
	const sql = queryCalls.at(-1)!.sql;
	assert.ok(sql.includes("agent_registry"), "must join through agent_registry");
	assert.ok(sql.includes("agent_identity"), "must filter by agent_identity");
	const params = queryCalls.at(-1)!.params;
	assert.equal(params[0], "claude-opus");
});

test("OFFLINE_ALERT_THRESHOLD_MINUTES is 10", () => {
	assert.equal(OFFLINE_ALERT_THRESHOLD_MINUTES, 10);
});

// ─── P765 AC-3/AC-4: scanAndAlertOfflineAgencies ─────────────────────────

test("scanAndAlertOfflineAgencies AC-3: queries for offline agencies past threshold (SQL check)", async () => {
	// Return empty rows for both queries (new alerts + recovery)
	let callCount = 0;
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		callCount++;
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: [], rowCount: 0 } as any;
	});

	queryCalls.length = 0;
	await scanAndAlertOfflineAgencies(10);

	// First SELECT: offline agencies with alert_sent_at IS NULL
	const firstSelect = queryCalls.find((c) =>
		c.sql.includes("offline_alert_sent_at IS NULL"),
	);
	assert.ok(firstSelect, "must query for agencies with no alert sent yet");
	assert.ok(
		firstSelect.sql.includes("offline"),
		"must filter for offline status",
	);
	assert.equal(
		firstSelect.params[0],
		10,
		"must pass threshold minutes as param",
	);

	// Second SELECT: recovered agencies with alert_sent_at set
	const recoverySelect = queryCalls.find((c) =>
		c.sql.includes("offline_alert_sent_at IS NOT NULL"),
	);
	assert.ok(
		recoverySelect,
		"must query for recovered agencies with pending alert flag",
	);

	// Restore original mock
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: mockRows, rowCount: mockRows.length } as any;
	});
});

test("scanAndAlertOfflineAgencies AC-4: SELECT uses IS NULL guard to prevent repeat alerts (SQL check)", async () => {
	// Return empty rows so enqueueNotification is never called (avoids real DB hit).
	// The deduplication invariant is enforced by the IS NULL guard in the SELECT —
	// if that condition exists in the query, re-alerting within an episode is impossible.
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: [], rowCount: 0 } as any;
	});

	queryCalls.length = 0;
	await scanAndAlertOfflineAgencies(10);

	const offlineSelect = queryCalls.find((c) =>
		c.sql.includes("offline_alert_sent_at IS NULL"),
	);
	assert.ok(
		offlineSelect,
		"SELECT must gate on offline_alert_sent_at IS NULL to prevent repeat alerts within an episode",
	);

	// Restore original mock
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: mockRows, rowCount: mockRows.length } as any;
	});
});

test("scanAndAlertOfflineAgencies AC-4: clears alert flag on recovery (SQL check)", async () => {
	// Simulate one recovered agency still holding alert_sent_at
	const fakeRecovered = {
		agency_id: "agent-y",
		display_name: "Agent Y",
		provider: "anthropic",
		status: "active",
	};
	let selectCount = 0;
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		if (
			sql.includes("offline_alert_sent_at IS NOT NULL") &&
			selectCount++ === 0
		) {
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			return { rows: [fakeRecovered], rowCount: 1 } as any;
		}
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: [], rowCount: 0 } as any;
	});

	queryCalls.length = 0;
	await scanAndAlertOfflineAgencies(10);

	// Must UPDATE offline_alert_sent_at = NULL to clear the episode flag
	const clearUpdate = queryCalls.find(
		(c) =>
			c.sql.includes("offline_alert_sent_at") &&
			c.sql.includes("NULL") &&
			c.sql.includes("UPDATE") &&
			c.params[0] === "agent-y",
	);
	assert.ok(clearUpdate, "must clear offline_alert_sent_at = NULL on recovery");

	// Restore original mock
	_setQueryForTest(async (sql: string, params: unknown[] = []) => {
		queryCalls.push({ sql, params });
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		return { rows: mockRows, rowCount: mockRows.length } as any;
	});
});
