import assert from "node:assert/strict";
import { test } from "node:test";

// Track all query calls
const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let mockRows: Record<string, unknown>[] = [];

const discordCalls: Array<{ from: string; message: string; level: string }> =
	[];

const {
	resolveAgency,
	recordSpawnFailure,
	recordCheckIn,
	operatorResumeAgency,
	emitOfflineAlerts,
	THROTTLE_THRESHOLD,
	_setQueryForTest,
	_setDiscordForTest,
} = await import(
	"../../src/core/orchestration/resolvers/agency-resolver.ts"
);

_setQueryForTest(async (sql: string, params: unknown[] = []) => {
	queryCalls.push({ sql, params });
	// biome-ignore lint/suspicious/noExplicitAny: test mock returns partial QueryResult shape
	return { rows: mockRows, rowCount: mockRows.length } as any;
});

_setDiscordForTest(async (from: string, message: string, level = "info") => {
	discordCalls.push({ from, message, level });
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

// --- P765 AC-1: offline → dormant auto-recovery ---

test("recordCheckIn includes offline→dormant transition (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls[0].sql;
	assert.ok(
		sql.includes("offline"),
		"SQL should reference offline state transition",
	);
	assert.ok(
		sql.match(/old_status\s*=\s*'offline'/),
		"SQL should handle offline as a CASE branch",
	);
});

test("recordCheckIn does not exclude offline agencies from WHERE clause (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls[0].sql;
	// Only 'retired' should be excluded; 'offline' must not appear in NOT IN list
	assert.ok(
		!sql.match(/NOT IN\s*\(\s*'offline'/),
		"offline must not be in NOT IN exclusion list",
	);
	assert.ok(sql.includes("retired"), "retired should still be excluded");
});

test("recordCheckIn clears alert_sent_at when dormant→active (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	const sql = queryCalls[0].sql;
	assert.ok(
		sql.includes("alert_sent_at"),
		"SQL should reference alert_sent_at column",
	);
	// The dormant→active branch must null it out
	assert.ok(
		sql.includes("NULL"),
		"SQL should set alert_sent_at to NULL on recovery",
	);
});

test("recordCheckIn emits Discord recovery when dormant→active had alert (behavior check)", async () => {
	mockRows = [
		{
			new_status: "active",
			project_id: null,
			old_status: "dormant",
			had_alert: true,
		},
	];
	discordCalls.length = 0;
	queryCalls.length = 0;
	await recordCheckIn("claude-opus");
	assert.equal(discordCalls.length, 1);
	assert.equal(discordCalls[0].level, "success");
	assert.ok(discordCalls[0].message.includes("claude-opus"));
});

test("recordCheckIn does not emit Discord when no prior alert (behavior check)", async () => {
	mockRows = [
		{
			new_status: "active",
			project_id: null,
			old_status: "dormant",
			had_alert: false,
		},
	];
	discordCalls.length = 0;
	await recordCheckIn("claude-opus");
	assert.equal(discordCalls.length, 0);
});

// --- P765 AC-2: operatorResumeAgency ---

test("operatorResumeAgency sets status to active from any non-retired state (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await operatorResumeAgency("claude-opus");
	const sql = queryCalls[0].sql;
	assert.ok(sql.includes("'active'"), "SQL should set status = 'active'");
	assert.ok(
		sql.includes("Operator resume"),
		"SQL should set status_reason to Operator resume",
	);
	assert.ok(
		sql.includes("alert_sent_at"),
		"SQL should clear alert_sent_at",
	);
	assert.ok(sql.includes("agent_identity"), "SQL should join via agent_identity");
	assert.ok(
		sql.includes("retired"),
		"SQL should still exclude retired agencies",
	);
});

test("operatorResumeAgency emits Discord recovery when alert was set (behavior check)", async () => {
	mockRows = [{ project_id: null, had_alert: true }];
	discordCalls.length = 0;
	queryCalls.length = 0;
	await operatorResumeAgency("claude-opus");
	assert.equal(discordCalls.length, 1);
	assert.equal(discordCalls[0].level, "success");
	assert.ok(discordCalls[0].message.includes("claude-opus"));
	assert.ok(discordCalls[0].message.includes("operator"));
});

test("operatorResumeAgency skips Discord when no prior alert (behavior check)", async () => {
	mockRows = [{ project_id: null, had_alert: false }];
	discordCalls.length = 0;
	await operatorResumeAgency("claude-opus");
	assert.equal(discordCalls.length, 0);
});

// --- P765 AC-3/AC-4: emitOfflineAlerts ---

test("emitOfflineAlerts targets offline agencies past 10-min threshold (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	await emitOfflineAlerts();
	const sql = queryCalls[0].sql;
	assert.ok(sql.includes("'offline'"), "SQL should filter on offline status");
	assert.ok(
		sql.includes("10 minutes"),
		"SQL should use 10-minute threshold",
	);
	assert.ok(
		sql.includes("alert_sent_at IS NULL"),
		"SQL should only flag rows with no prior alert (AC-4)",
	);
	assert.ok(
		sql.includes("alert_sent_at = now()"),
		"SQL should stamp alert_sent_at to prevent repeat alerts",
	);
});

test("emitOfflineAlerts fires Discord warning for each flagged agency", async () => {
	mockRows = [
		{ project_id: null, agent_identity: "claude-opus" },
		{ project_id: "proj-x", agent_identity: "gemini-pro" },
	];
	discordCalls.length = 0;
	await emitOfflineAlerts();
	assert.equal(discordCalls.length, 2);
	assert.ok(discordCalls.every((c) => c.level === "warning"));
	assert.ok(discordCalls.some((c) => c.message.includes("claude-opus")));
	assert.ok(discordCalls.some((c) => c.message.includes("gemini-pro")));
});

test("emitOfflineAlerts returns count of flagged agencies", async () => {
	mockRows = [
		{ project_id: null, agent_identity: "agency-1" },
		{ project_id: "proj-a", agent_identity: "agency-2" },
	];
	const count = await emitOfflineAlerts();
	assert.equal(count, 2);
});

test("emitOfflineAlerts returns 0 when nothing is overdue", async () => {
	mockRows = [];
	const count = await emitOfflineAlerts();
	assert.equal(count, 0);
});

// --- P765 AC-5: dormant→offline silence boundary (SQL shape check) ---

test("scanAndTransitionSilentAgencies uses 5-min dormant and 30-min offline thresholds (SQL check)", async () => {
	mockRows = [];
	queryCalls.length = 0;
	const { scanAndTransitionSilentAgencies } = await import(
		"../../src/core/orchestration/resolvers/agency-resolver.ts"
	);
	await scanAndTransitionSilentAgencies();
	const sqls = queryCalls.slice(-2).map((c) => c.sql);
	assert.ok(
		sqls.some((s) => s.includes("30 minutes")),
		"offline transition should use 30-min threshold",
	);
	assert.ok(
		sqls.some((s) => s.includes("5 minutes")),
		"dormant transition should use 5-min threshold",
	);
});
