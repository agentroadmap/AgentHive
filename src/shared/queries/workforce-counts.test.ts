import assert from "node:assert";
import { describe, test } from "node:test";
import {
	computeWorkforceMetrics,
	queryWorkforceMetrics,
	WORKFORCE_METRICS_SQL,
	type WorkforceRow,
} from "./workforce-counts.ts";

/** Build n rows with a given shape. */
function rows(n: number, shape: Partial<WorkforceRow>): WorkforceRow[] {
	return Array.from({ length: n }, () => ({
		status: "active",
		reaped_at: null,
		preferred_provider: "claude",
		presence_state: null,
		agency_id: null,
		...shape,
	}));
}

describe("computeWorkforceMetrics (P1377 AC-1/AC-4/AC-6/AC-10)", () => {
	test("AC-4 fixture: 269 active, 4 registered (2 online), providers 150/70/49", () => {
		const fixture: WorkforceRow[] = [
			// 4 registered, 2 of them online
			...rows(2, {
				agency_id: "a",
				presence_state: "online",
				preferred_provider: "claude",
			}),
			...rows(2, {
				agency_id: "a",
				presence_state: "offline",
				preferred_provider: "claude",
			}),
			// remaining 265 drift, provider split → totals: claude 150, codex 70, antigravity 49
			...rows(146, { preferred_provider: "claude" }), // +4 registered claude = 150
			...rows(70, { preferred_provider: "codex" }),
			...rows(49, { preferred_provider: "antigravity" }),
		];
		const m = computeWorkforceMetrics(fixture);
		assert.equal(m.total_agents, 269);
		assert.equal(m.total_providers, 3);
		assert.equal(m.online_count, 2);
		assert.equal(m.registered_agencies, 4);
		assert.equal(m.drift_count, 265);
	});

	test("AC-6 fixture: 100 active, 20 registered (8 online), 3 providers", () => {
		const fixture: WorkforceRow[] = [
			...rows(8, {
				agency_id: "a",
				presence_state: "busy",
				preferred_provider: "claude",
			}),
			...rows(12, {
				agency_id: "a",
				presence_state: "offline",
				preferred_provider: "codex",
			}),
			...rows(80, { preferred_provider: "gemini" }),
		];
		const m = computeWorkforceMetrics(fixture);
		assert.equal(m.total_agents, 100);
		assert.equal(m.total_providers, 3);
		assert.equal(m.online_count, 8);
		assert.equal(m.registered_agencies, 20);
		assert.equal(m.drift_count, 80);
	});

	test("invariant online ≤ registered ≤ total holds (AC-10)", () => {
		const m = computeWorkforceMetrics([
			...rows(5, { agency_id: "a", presence_state: "online" }),
			...rows(3, { agency_id: "a", presence_state: "offline" }),
			...rows(10, {}),
		]);
		assert.ok(m.online_count <= m.registered_agencies);
		assert.ok(m.registered_agencies <= m.total_agents);
		assert.equal(m.online_count, 5);
		assert.equal(m.registered_agencies, 8);
	});

	test("reaped + non-active rows excluded", () => {
		const m = computeWorkforceMetrics([
			...rows(3, { agency_id: "a", presence_state: "online" }),
			...rows(2, {
				status: "retired",
				agency_id: "a",
				presence_state: "online",
			}),
			...rows(2, {
				reaped_at: "2026-01-01",
				agency_id: "a",
				presence_state: "online",
			}),
		]);
		assert.equal(m.total_agents, 3);
		assert.equal(m.online_count, 3);
	});

	test("an unregistered (drift) online agent does NOT count as online", () => {
		// presence online but no agency row → drift, not online (the bug P1377 fixes)
		const m = computeWorkforceMetrics(
			rows(4, { presence_state: "online", agency_id: null }),
		);
		assert.equal(m.online_count, 0);
		assert.equal(m.drift_count, 4);
	});
});

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";
describe(
	"queryWorkforceMetrics live (P1377 AC-1/AC-6, env-gated)",
	{ skip: !DB_TEST },
	() => {
		test("live query returns 5 numeric columns with online ≤ registered ≤ total", async () => {
			const { Client } = await import("pg");
			const client = new Client({
				host: process.env.PGHOST || "127.0.0.1",
				port: parseInt(process.env.PGPORT || "5432", 10),
				user: process.env.PGUSER || "admin",
				password: process.env.PGPASSWORD,
				database: process.env.PGDATABASE || "agenthive",
			});
			await client.connect();
			try {
				const m = await queryWorkforceMetrics(
					(sql) => client.query(sql) as never,
				);
				for (const k of [
					"total_agents",
					"total_providers",
					"online_count",
					"registered_agencies",
					"drift_count",
				] as const) {
					assert.equal(typeof m[k], "number");
					assert.ok(Number.isFinite(m[k]));
				}
				assert.ok(
					m.online_count <= m.registered_agencies,
					"online ≤ registered",
				);
				assert.ok(
					m.registered_agencies <= m.total_agents,
					"registered ≤ total",
				);
			} finally {
				await client.end();
			}
		});

		test("SQL constant is non-empty and joins agency on agent_identity", () => {
			assert.match(
				WORKFORCE_METRICS_SQL,
				/LEFT JOIN roadmap\.agency a ON a\.agency_id = ar\.agent_identity/,
			);
		});
	},
);
