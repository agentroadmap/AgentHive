/**
 * P765 AC-5: Unit tests for agency liveness auto-recovery and alerting.
 *
 * All tests use _setQueryForTest to inject mock query functions —
 * no DB connection required.
 *
 * AC-1: offline → dormant on heartbeat (auto-recovery)
 * AC-2: operator resumeAgencyProviderLiaison → active from any state
 * AC-3: Discord alert fires when agency offline >10 min
 * AC-4: alert is single-shot; resolved-alert sent on recovery
 * AC-5: scanAndTransitionSilentAgencies transitions dormant→offline correctly
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
	_setQueryForTest,
	recordCheckIn,
	resumeAgencyProviderLiaison,
	scanAndTransitionSilentAgencies,
} from "../../src/core/orchestration/resolvers/agency-resolver.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockCall = { sql: string; params: unknown[] };

/** Build a mock query function that records calls and returns preset results. */
function makeMockQuery(results: Array<{ rows: unknown[]; rowCount?: number }>) {
	const calls: MockCall[] = [];
	let idx = 0;

	const mockFn = (sql: string, params: unknown[] = []) => {
		calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
		const result = results[idx] ?? { rows: [], rowCount: 0 };
		idx++;
		return Promise.resolve({
			rows: result.rows,
			rowCount: result.rowCount ?? result.rows.length,
		});
	};

	return { mockFn: mockFn as Parameters<typeof _setQueryForTest>[0], calls };
}

let realQuery: Parameters<typeof _setQueryForTest>[0] | null = null;

beforeEach(() => {
	// Store a no-op so afterEach can restore it
	realQuery = (() =>
		Promise.resolve({ rows: [], rowCount: 0 })) as Parameters<
		typeof _setQueryForTest
	>[0];
});

afterEach(() => {
	if (realQuery) _setQueryForTest(realQuery);
});

// ─── AC-1: offline → dormant auto-recovery ───────────────────────────────────

describe("recordCheckIn — AC-1 offline→dormant auto-recovery", () => {
	it("transitions offline agency to dormant on heartbeat", async () => {
		const { mockFn, calls } = makeMockQuery([
			{
				rows: [
					{
						old_status: "offline",
						new_status: "dormant",
						had_alert: false,
					},
				],
			},
			{ rows: [] }, // pg_notify('work_offers')
		]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-offline");

		// First call is the CTE update
		assert.ok(
			calls[0].sql.includes("offline") && calls[0].sql.includes("dormant"),
			"CTE must handle offline→dormant transition",
		);
		// Second call must be orchestrator wake
		assert.ok(
			calls[1]?.sql.includes("pg_notify") &&
				calls[1].sql.includes("work_offers"),
			"must emit orchestrator wake on recovery",
		);
	});

	it("does not wake orchestrator for already-active agency check-in", async () => {
		const { mockFn, calls } = makeMockQuery([
			{
				rows: [
					{
						old_status: "active",
						new_status: "active",
						had_alert: false,
					},
				],
			},
		]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-active");

		assert.equal(calls.length, 1, "no extra notify for an already-active agency");
	});

	it("clears offline_since_at and offline_alerted_at on offline→dormant", async () => {
		const { mockFn, calls } = makeMockQuery([
			{
				rows: [
					{
						old_status: "offline",
						new_status: "dormant",
						had_alert: false,
					},
				],
			},
			{ rows: [] },
		]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-offline-clear");

		const cteSql = calls[0].sql;
		assert.ok(
			cteSql.includes("offline_since_at"),
			"must clear offline_since_at",
		);
		assert.ok(
			cteSql.includes("offline_alerted_at"),
			"must clear offline_alerted_at",
		);
	});

	it("still excludes retired agencies from check-in", async () => {
		const { mockFn, calls } = makeMockQuery([{ rows: [] }]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-retired");

		assert.ok(
			calls[0].sql.includes("NOT IN ('retired')"),
			"retired agencies must be excluded",
		);
	});
});

// ─── AC-4: resolved alert on recovery ────────────────────────────────────────

describe("recordCheckIn — AC-4 resolved alert", () => {
	it("sends discord resolved alert when recovering from alerted offline episode", async () => {
		const discordCalls: MockCall[] = [];

		const { mockFn, calls } = makeMockQuery([
			{
				rows: [
					{
						old_status: "offline",
						new_status: "dormant",
						had_alert: true,
					},
				],
			},
			{ rows: [] }, // discord pg_notify
			{ rows: [] }, // work_offers pg_notify
		]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-alerted");

		// With had_alert=true, should emit a discord notify before the wake notify
		const notifyCalls = calls.filter((c) => c.sql.includes("pg_notify"));
		assert.ok(notifyCalls.length >= 2, "must emit both discord and wake notifies");
		const discordCall = notifyCalls.find((c) =>
			c.sql.includes("discord_send"),
		);
		assert.ok(discordCall, "must emit discord recovery alert");
		const payload = JSON.parse(discordCall!.params[0] as string);
		assert.equal(payload.level, "success", "recovery alert must be success level");
		assert.ok(
			(payload.message as string).includes("recovered"),
			"message must mention recovery",
		);
	});

	it("skips discord alert when agency recovered without a prior alert", async () => {
		const { mockFn, calls } = makeMockQuery([
			{
				rows: [
					{
						old_status: "offline",
						new_status: "dormant",
						had_alert: false,
					},
				],
			},
			{ rows: [] }, // only work_offers wake, no discord
		]);
		_setQueryForTest(mockFn);

		await recordCheckIn("test/agency-no-prior-alert");

		const discordCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("discord_send"),
		);
		assert.equal(
			discordCall,
			undefined,
			"must not send discord alert when no prior alert was sent",
		);
	});
});

// ─── AC-2: operator resume_liaison ───────────────────────────────────────────

describe("resumeAgencyProviderLiaison — AC-2 operator short-circuit", () => {
	it("sets status=active and clears offline columns", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 1 }, // UPDATE
			{ rows: [] }, // pg_notify
		]);
		_setQueryForTest(mockFn);

		await resumeAgencyProviderLiaison("test/agency-stuck");

		const updateSql = calls[0].sql;
		assert.ok(updateSql.includes("status = 'active'"), "must set active");
		assert.ok(
			updateSql.includes("offline_since_at   = NULL") ||
				updateSql.includes("offline_since_at = NULL"),
			"must clear offline_since_at",
		);
		assert.ok(
			updateSql.includes("offline_alerted_at = NULL"),
			"must clear offline_alerted_at",
		);
		assert.ok(
			updateSql.includes("<> 'retired'"),
			"must not affect retired agencies",
		);
	});

	it("emits orchestrator wake after resume", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 1 },
			{ rows: [] },
		]);
		_setQueryForTest(mockFn);

		await resumeAgencyProviderLiaison("test/agency-resume");

		const wakeCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("work_offers"),
		);
		assert.ok(wakeCall, "must emit work_offers wake after operator resume");
	});
});

// ─── AC-3/AC-5: scanner transitions and alert emission ───────────────────────

describe("scanAndTransitionSilentAgencies — AC-3/AC-5", () => {
	it("transitions active/dormant → offline when silent >30 min (sets offline_since_at)", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 2 }, // offline transition
			{ rows: [], rowCount: 0 }, // dormant transition
			{ rows: [], rowCount: 0 }, // emitOfflineAlerts CTE UPDATE
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const offlineSql = calls[0].sql;
		assert.ok(
			offlineSql.includes("status = 'offline'"),
			"must transition to offline",
		);
		assert.ok(
			offlineSql.includes("offline_since_at = now()"),
			"must set offline_since_at timestamp",
		);
		assert.ok(
			offlineSql.includes("IN ('active', 'dormant')"),
			"must only transition active/dormant",
		);
		assert.ok(
			offlineSql.includes("interval '30 minutes'"),
			"must use 30-minute silence threshold",
		);
	});

	it("transitions active → dormant when silent >5 min", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 1 },
			{ rows: [], rowCount: 0 },
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const dormantSql = calls[1].sql;
		assert.ok(
			dormantSql.includes("status = 'dormant'"),
			"must transition to dormant",
		);
		assert.ok(
			dormantSql.includes("status = 'active'"),
			"must only check active agencies for dormant",
		);
		assert.ok(
			dormantSql.includes("interval '5 minutes'"),
			"must use 5-minute silence threshold",
		);
	});

	it("emits Discord warning alert for agencies offline >10 min", async () => {
		const alertedRow = {
			id: "42",
			agent_identity: "test/overdue-agency",
			project_id: null,
		};

		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 }, // offline transition
			{ rows: [], rowCount: 0 }, // dormant transition
			{ rows: [alertedRow], rowCount: 1 }, // emitOfflineAlerts CTE UPDATE
			{ rows: [] }, // discord pg_notify
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const alertCte = calls[2].sql;
		assert.ok(
			alertCte.includes("offline_alerted_at = now()"),
			"must stamp offline_alerted_at",
		);
		assert.ok(
			alertCte.includes("offline_alerted_at IS NULL"),
			"must only alert once per offline episode",
		);
		assert.ok(
			alertCte.includes("interval '10 minutes'"),
			"must use 10-minute threshold for alert",
		);

		const discordCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("discord_send"),
		);
		assert.ok(discordCall, "must send discord alert");
		const payload = JSON.parse(discordCall!.params[0] as string);
		assert.equal(payload.level, "warning", "offline alert must be warning level");
		assert.ok(
			(payload.message as string).includes("test/overdue-agency"),
			"alert must include agency identity",
		);
		assert.ok(
			(payload.message as string).includes("10 minutes"),
			"alert must mention 10-minute threshold",
		);
	});

	it("does not emit alert when no agencies qualify", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 }, // no qualifying agencies
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const discordCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("discord_send"),
		);
		assert.equal(discordCall, undefined, "must not send alert when no qualifying agencies");
	});

	it("includes project_id in CTE RETURNING for scope-aware routing", async () => {
		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 },
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const alertCte = calls[2].sql;
		assert.ok(
			alertCte.includes("project_id"),
			"must select project_id from provider_registry for scope routing",
		);
	});
});

// ─── AC-5: scope-aware payload discrimination ────────────────────────────────

describe("emitOfflineAlerts — AC-5 scope-aware routing", () => {
	it("sets scope=global and project_id=null for a global agency", async () => {
		const globalRow = {
			id: "10",
			agent_identity: "platform/global-worker",
			project_id: null,
		};

		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 },
			{ rows: [globalRow], rowCount: 1 },
			{ rows: [] }, // discord pg_notify
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const discordCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("discord_send"),
		);
		assert.ok(discordCall, "must send discord alert for global agency");
		const payload = JSON.parse(discordCall!.params[0] as string);
		assert.equal(payload.scope, "global", "global agency alert must have scope=global");
		assert.equal(payload.project_id, null, "global agency alert must have project_id=null");
	});

	it("sets scope=tenant and project_id for a tenant-scoped agency", async () => {
		const tenantRow = {
			id: "20",
			agent_identity: "project-7/worker",
			project_id: "7",
		};

		const { mockFn, calls } = makeMockQuery([
			{ rows: [], rowCount: 0 },
			{ rows: [], rowCount: 0 },
			{ rows: [tenantRow], rowCount: 1 },
			{ rows: [] }, // discord pg_notify
		]);
		_setQueryForTest(mockFn);

		await scanAndTransitionSilentAgencies();

		const discordCall = calls.find(
			(c) => c.sql.includes("pg_notify") && c.sql.includes("discord_send"),
		);
		assert.ok(discordCall, "must send discord alert for tenant agency");
		const payload = JSON.parse(discordCall!.params[0] as string);
		assert.equal(payload.scope, "tenant", "tenant agency alert must have scope=tenant");
		assert.equal(payload.project_id, "7", "tenant agency alert must carry project_id");
	});
});
