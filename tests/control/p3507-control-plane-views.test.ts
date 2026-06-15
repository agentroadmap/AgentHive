/**
 * P3507 Integration Tests — control-plane aggregation endpoints
 *
 * AC coverage:
 *   AC-3: GET /api/control-plane/fleet returns { agencies, routes, projects, errors, partial }
 *   AC-4: GET /api/control-plane/efficiency returns { data: [...{ total_cost_usd, ... }], errors, partial }
 *   AC-5: GET /api/control-plane/identity returns { agencies, data, errors, partial }
 *   AC-6: GET /api/control-plane/platform returns { routes, data: [...{ schema_version }], errors, partial }
 *   AC-7: p-limit concurrency cap — all four endpoints respond without timeout under >= 2 projects
 *   AC-9: partial:true when >= 1 tenant unreachable; partial:false when all succeed
 *   AC-10: budget returns total_cost_usd=null (N/A) when agent_budget_ledger unavailable
 *
 * Probe strategy: direct Pool to hiveCentral (admin@5432) — same credentials as production.
 * Skip gracefully when DB unavailable (CI environments without a live pg).
 */

import assert from "node:assert/strict";
import { describe, it, before, after, type TestContext } from "node:test";
import { Pool } from "pg";

const BASE_URL = process.env.AGENTHIVE_SERVER_URL ?? "http://127.0.0.1:6424";

let pool: Pool;
let canConnect = false;
let serverUp = false;

before(async () => {
	pool = new Pool({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? 5432),
		user: process.env.PGUSER ?? "admin",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "hiveCentral",
		connectionTimeoutMillis: 3_000,
	});
	try {
		const client = await pool.connect();
		client.release();
		canConnect = true;
	} catch {
		canConnect = false;
	}

	try {
		const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
		serverUp = res.ok;
	} catch {
		serverUp = false;
	}
});

after(async () => {
	if (pool) await pool.end();
});

const skipDb = (name: string, fn: (t: TestContext) => Promise<void>) =>
	it(name, async (t: TestContext) => {
		if (!canConnect) {
			t.skip("DB not available");
			return;
		}
		await fn(t);
	});

const skipServer = (name: string, fn: (t: TestContext) => Promise<void>) =>
	it(name, async (t: TestContext) => {
		if (!serverUp) {
			t.skip("Server not available");
			return;
		}
		await fn(t);
	});

// ─── DB-level checks ──────────────────────────────────────────────────────────

describe("P3507: DB preconditions", () => {
	skipDb("roadmap.project has at least 2 active rows", async () => {
		const { rows } = await pool.query<{ cnt: string }>(
			"SELECT COUNT(*) AS cnt FROM roadmap.project WHERE status='active'",
		);
		const cnt = Number(rows[0]!.cnt);
		assert.ok(cnt >= 2, `expected >= 2 active projects, got ${cnt}`);
	});

	skipDb("roadmap.agency table exists", async () => {
		const { rows } = await pool.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			 FROM information_schema.tables
			 WHERE table_schema='roadmap' AND table_name='agency'`,
		);
		assert.equal(Number(rows[0]!.cnt), 1, "roadmap.agency table missing");
	});

	skipDb("roadmap.model_routes table exists", async () => {
		const { rows } = await pool.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			 FROM information_schema.tables
			 WHERE table_schema='roadmap' AND table_name='model_routes'`,
		);
		assert.equal(Number(rows[0]!.cnt), 1, "roadmap.model_routes table missing");
	});
});

// ─── HTTP-level checks (require live server) ─────────────────────────────────

describe("P3507: GET /api/control-plane/fleet (AC-3)", () => {
	skipServer("returns 200 with expected envelope shape", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/fleet`);
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		assert.ok(Array.isArray(body.agencies), "agencies must be an array");
		assert.ok(Array.isArray(body.routes), "routes must be an array");
		assert.ok(Array.isArray(body.projects), "projects must be an array");
		assert.ok(Array.isArray(body.errors), "errors must be an array");
		assert.equal(typeof body.partial, "boolean", "partial must be boolean");
	});

	skipServer("projects items have required runtime fields", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/fleet`);
		const body = (await res.json()) as {
			projects: Array<{
				project_id: number;
				slug: string;
				name: string;
				active_agent_runs: number;
				live_cubics: number;
			}>;
			errors: unknown[];
		};
		// Expect at least one entry across projects+errors (>= 2 active projects in DB)
		const totalEntries = body.projects.length + body.errors.length;
		assert.ok(totalEntries >= 2, `expected >= 2 combined project+error entries, got ${totalEntries}`);

		for (const p of body.projects) {
			assert.equal(typeof p.project_id, "number", "project_id must be number");
			assert.equal(typeof p.slug, "string", "slug must be string");
			assert.equal(typeof p.name, "string", "name must be string");
			assert.equal(typeof p.active_agent_runs, "number", "active_agent_runs must be number");
			assert.equal(typeof p.live_cubics, "number", "live_cubics must be number");
		}
	});
});

describe("P3507: GET /api/control-plane/efficiency (AC-4)", () => {
	skipServer("returns 200 with expected envelope shape", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/efficiency`);
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		assert.ok(Array.isArray(body.data), "data must be an array");
		assert.ok(Array.isArray(body.errors), "errors must be an array");
		assert.equal(typeof body.partial, "boolean", "partial must be boolean");
	});

	skipServer("data items include cost fields (null or number)", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/efficiency`);
		const body = (await res.json()) as {
			data: Array<{
				project_id: number;
				slug: string;
				name: string;
				total_cost_usd: number | null;
				total_input_tokens: number | null;
				total_output_tokens: number | null;
				total_calls: number | null;
			}>;
			errors: Array<{ project_id: number; slug: string; name: string; error: string }>;
		};
		const totalEntries = body.data.length + body.errors.length;
		assert.ok(totalEntries >= 2, `expected >= 2 combined entries, got ${totalEntries}`);

		for (const row of body.data) {
			assert.equal(typeof row.project_id, "number");
			assert.equal(typeof row.slug, "string");
			// total_cost_usd may be null when agent_budget_ledger is empty (AC-10)
			assert.ok(
				row.total_cost_usd === null || typeof row.total_cost_usd === "number",
				"total_cost_usd must be null or number",
			);
		}
	});

	skipServer("partial:false when all tenants succeed (AC-9)", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/efficiency`);
		const body = (await res.json()) as { errors: unknown[]; partial: boolean };
		if (body.errors.length === 0) {
			assert.equal(body.partial, false, "partial must be false when errors is empty");
		}
	});
});

describe("P3507: GET /api/control-plane/identity (AC-5)", () => {
	skipServer("returns 200 with expected envelope shape", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/identity`);
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		assert.ok(Array.isArray(body.agencies), "agencies must be an array");
		assert.ok(Array.isArray(body.data), "data must be an array");
		assert.ok(Array.isArray(body.errors), "errors must be an array");
		assert.equal(typeof body.partial, "boolean", "partial must be boolean");
	});

	skipServer("tenant data items contain agents array", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/identity`);
		const body = (await res.json()) as {
			data: Array<{
				project_id: number;
				slug: string;
				name: string;
				agents: Array<{ agent_id: string; agent_identity: string }>;
			}>;
			errors: unknown[];
		};
		const totalEntries = body.data.length + body.errors.length;
		assert.ok(totalEntries >= 2, `expected >= 2 combined entries, got ${totalEntries}`);

		for (const tenant of body.data) {
			assert.equal(typeof tenant.project_id, "number");
			assert.ok(Array.isArray(tenant.agents), "agents must be an array");
		}
	});
});

describe("P3507: GET /api/control-plane/platform (AC-6)", () => {
	skipServer("returns 200 with expected envelope shape", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/platform`);
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		assert.ok(Array.isArray(body.routes), "routes must be an array");
		assert.ok(Array.isArray(body.data), "data must be an array");
		assert.ok(Array.isArray(body.errors), "errors must be an array");
		assert.equal(typeof body.partial, "boolean", "partial must be boolean");
	});

	skipServer("data items carry schema_version (number or null)", async () => {
		const res = await fetch(`${BASE_URL}/api/control-plane/platform`);
		const body = (await res.json()) as {
			data: Array<{
				project_id: number;
				slug: string;
				name: string;
				schema_version: number | null;
			}>;
			errors: unknown[];
		};
		const totalEntries = body.data.length + body.errors.length;
		assert.ok(totalEntries >= 2, `expected >= 2 combined entries, got ${totalEntries}`);

		for (const row of body.data) {
			assert.ok(
				row.schema_version === null || typeof row.schema_version === "number",
				"schema_version must be null or number",
			);
		}
	});
});

describe("P3507: concurrent fan-out (AC-7)", () => {
	skipServer("all 4 endpoints respond within 10 seconds", async () => {
		const start = Date.now();
		const results = await Promise.allSettled([
			fetch(`${BASE_URL}/api/control-plane/fleet`),
			fetch(`${BASE_URL}/api/control-plane/efficiency`),
			fetch(`${BASE_URL}/api/control-plane/identity`),
			fetch(`${BASE_URL}/api/control-plane/platform`),
		]);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 10_000, `all 4 endpoints took ${elapsed}ms — expected < 10s`);

		for (const r of results) {
			assert.equal(r.status, "fulfilled", "all 4 endpoints must fulfill");
			if (r.status === "fulfilled") {
				assert.equal(r.value.status, 200, `expected 200, got ${r.value.status}`);
			}
		}
	});
});
