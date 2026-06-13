import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConfigResolver, ProjectIdMissing } from "./config.ts";
import { FlagKeys, RegistryKeys } from "./config-keys.ts";

/**
 * P827 Phase 2: scoped core.runtime_flag resolution. Pure unit tests with a
 * mock pool — no live DB. Each test builds a fresh ConfigResolver so the
 * in-process cache never leaks across cases.
 */

interface MockClient {
	query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
	on: () => void;
	release: () => void;
}

/**
 * Mock pg Pool. `rowsByScope` maps a scope string (e.g. 'project:my-proj',
 * 'global') to the value_jsonb returned for that scope. A `queries` array
 * records every (flagName, scope) the resolver actually hit, so we can assert
 * short-circuit behaviour and re-fetch.
 */
function mockPool(
	rowsByScope: Record<string, unknown>,
	queries: string[][] = [],
) {
	const client: MockClient = {
		query: async () => ({ rows: [] }), // LISTEN no-op
		on: () => {},
		release: () => {},
	};
	return {
		queries,
		query: async (_sql: string, params?: unknown[]) => {
			const flagName = String(params?.[0]);
			const scope = String(params?.[1]);
			queries.push([flagName, scope]);
			if (scope in rowsByScope) {
				return { rows: [{ value_jsonb: rowsByScope[scope] }] };
			}
			return { rows: [] };
		},
		connect: async () => client,
		options: {},
	} as never;
}

// Keys under test resolve from DB only when env doesn't short-circuit them.
const CLEARED_ENV = [
	"USE_OFFER_DISPATCH",
	"PROJECT_TOKEN_BUDGET",
	"PGPORT_DIRECT",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of CLEARED_ENV) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of CLEARED_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("ConfigResolver scoped runtime_flag resolution (P827)", () => {
	test("AC-13: project-scoped value wins over global when both exist", async () => {
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({ "project:my-proj": true, global: false }),
			scopeContext: { projectSlug: "my-proj" },
		});
		const v = await r.get(FlagKeys.USE_OFFER_DISPATCH);
		assert.equal(
			v,
			true,
			"should return the project:my-proj value, not global",
		);
		await r.cleanup();
	});

	test("AC-2: priority order short-circuits on first hit (project before global)", async () => {
		const queries: string[][] = [];
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({ "project:my-proj": true, global: false }, queries),
			scopeContext: { projectSlug: "my-proj" },
		});
		await r.get(FlagKeys.USE_OFFER_DISPATCH);
		// project candidate matched first → global must NOT have been queried.
		assert.deepEqual(queries, [["USE_OFFER_DISPATCH", "project:my-proj"]]);
		await r.cleanup();
	});

	test("AC-2: falls through to global when no project row", async () => {
		const queries: string[][] = [];
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({ global: true }, queries),
			scopeContext: { projectSlug: "my-proj" },
		});
		const v = await r.get(FlagKeys.USE_OFFER_DISPATCH);
		assert.equal(v, true);
		assert.deepEqual(queries, [
			["USE_OFFER_DISPATCH", "project:my-proj"],
			["USE_OFFER_DISPATCH", "global"],
		]);
		await r.cleanup();
	});

	test("AC-14 / AC-19: notify evicts only the matching (flag,scope) dbCache entry", async () => {
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({}),
			scopeContext: { projectSlug: "my-proj" },
		});
		const dbCache = (r as never as { dbCache: Map<string, unknown> }).dbCache;
		// Seed two independent scope entries for the same flag (collision-proof keys).
		const kProj = "runtime_flag:USE_OFFER_DISPATCH:project:my-proj";
		const kGlobal = "runtime_flag:USE_OFFER_DISPATCH:global";
		dbCache.set(kProj, { value: true, resolvedAt: Date.now() });
		dbCache.set(kGlobal, { value: false, resolvedAt: Date.now() });

		(
			r as never as { handleFlagNotification: (p: string) => void }
		).handleFlagNotification(
			JSON.stringify({
				flag_name: "USE_OFFER_DISPATCH",
				scope: "project:my-proj",
			}),
		);

		assert.equal(dbCache.has(kProj), false, "matching scope evicted");
		assert.equal(
			dbCache.has(kGlobal),
			true,
			"unrelated scope survives (no scope collision)",
		);
		await r.cleanup();
	});

	test("AC-5: malformed notify payload flushes the whole dbCache (safe fallback)", async () => {
		const r = new ConfigResolver();
		await r.init({ pool: mockPool({}) });
		const dbCache = (r as never as { dbCache: Map<string, unknown> }).dbCache;
		dbCache.set("runtime_flag:X:global", { value: 1, resolvedAt: Date.now() });
		(
			r as never as { handleFlagNotification: (p: string) => void }
		).handleFlagNotification("not-json{");
		assert.equal(dbCache.size, 0, "malformed payload → full flush");
		await r.cleanup();
	});

	test("AC-7 / AC-15: a dbCache entry older than the TTL is re-fetched", async () => {
		const queries: string[][] = [];
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({ global: "fresh" }, queries),
			scopeContext: {},
		});
		const dbCache = (r as never as { dbCache: Map<string, unknown> }).dbCache;
		// Stale entry: resolvedAt 6 minutes ago (> 5 min TTL).
		dbCache.set("runtime_flag:USE_OFFER_DISPATCH:global", {
			value: "stale",
			resolvedAt: Date.now() - 360_000,
		});
		const got = await (
			r as never as { getScopedFlagValue: (f: string) => Promise<unknown> }
		).getScopedFlagValue("USE_OFFER_DISPATCH");
		assert.equal(got, "fresh", "stale entry must be re-fetched from DB");
		assert.deepEqual(queries, [["USE_OFFER_DISPATCH", "global"]]);
		await r.cleanup();
	});

	test("AC-7: a fresh dbCache entry is served without a DB query", async () => {
		const queries: string[][] = [];
		const r = new ConfigResolver();
		await r.init({
			pool: mockPool({ global: "db" }, queries),
			scopeContext: {},
		});
		const dbCache = (r as never as { dbCache: Map<string, unknown> }).dbCache;
		dbCache.set("runtime_flag:USE_OFFER_DISPATCH:global", {
			value: "cached",
			resolvedAt: Date.now(),
		});
		const got = await (
			r as never as { getScopedFlagValue: (f: string) => Promise<unknown> }
		).getScopedFlagValue("USE_OFFER_DISPATCH");
		assert.equal(got, "cached", "fresh cache hit");
		assert.equal(queries.length, 0, "no DB query on fresh hit");
		await r.cleanup();
	});

	test("AC-9 / AC-16: PROJECT_ key without projectSlug throws ProjectIdMissing (fail-closed)", async () => {
		const r = new ConfigResolver();
		await r.init({ pool: mockPool({ global: 100 }), scopeContext: {} });
		await assert.rejects(
			() => r.get(RegistryKeys.PROJECT_TOKEN_BUDGET),
			(err: unknown) => {
				assert.ok(err instanceof ProjectIdMissing);
				assert.equal((err as ProjectIdMissing).name, "ProjectIdMissing");
				assert.match((err as Error).message, /PROJECT_TOKEN_BUDGET/);
				return true;
			},
			"must fail closed, never silently fall through to global",
		);
		await r.cleanup();
	});

	test("AC-10: cleanup() is idempotent (no throw on double call)", async () => {
		const r = new ConfigResolver();
		await r.init({ pool: mockPool({}) });
		await r.cleanup();
		await r.cleanup(); // must not throw
		assert.ok(true);
	});
});
