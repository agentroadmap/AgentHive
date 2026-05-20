/**
 * P797: Model list registry — multi-platform filtering unit tests.
 *
 * Focuses on the provider/tier/project_id filter parameters, NO_ENABLED_ROUTE
 * structured errors, the 2-second SWR cache keying strategy, and the
 * validateModelForDispatch() pre-spawn guard.
 *
 * Complements tests/unit/p059-model-registry.test.ts which covers the
 * legacy capability/cost filters and base cache hit counting.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	getModelListMetrics,
	PgModelHandlers,
	resetModelListCacheForTest,
	validateModelForDispatch,
} from "../../src/apps/mcp-server/tools/spending/pg-handlers.ts";

type Row = {
	model_name: string;
	provider: string;
	tier: string;
	cost_per_million_input: string | null;
	context_window: number | null;
	capabilities: Record<string, boolean> | null;
	rating: number | null;
	is_active: boolean;
	route_provider: string;
	priority: number;
};

function makeRow(overrides: Partial<Row> = {}): Row {
	return {
		model_name: "claude-sonnet",
		provider: "anthropic",
		tier: "frontier",
		cost_per_million_input: "3",
		context_window: 200000,
		capabilities: { tool_use: true },
		rating: 4,
		is_active: true,
		route_provider: "anthropic",
		priority: 1,
		...overrides,
	};
}

function textOf(
	result: Awaited<ReturnType<PgModelHandlers["listModels"]>>,
): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

describe("P797: model_list multi-platform filtering", () => {
	beforeEach(() => {
		resetModelListCacheForTest();
	});

	describe("SQL filter pass-through", () => {
		it("passes active_only=true, provider, and tier as positional SQL params", async () => {
			let capturedParams: unknown[] | undefined;
			const queryFn = async <T>(_sql: string, params?: unknown[]) => {
				capturedParams = params;
				return { rows: [] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ provider: "openai", tier: "frontier" });

			assert.deepEqual(capturedParams, [true, "openai", "frontier", null]);
		});

		it("passes null for omitted provider and tier", async () => {
			let capturedParams: unknown[] | undefined;
			const queryFn = async <T>(_sql: string, params?: unknown[]) => {
				capturedParams = params;
				return { rows: [] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ active_only: false });

			assert.deepEqual(capturedParams, [false, null, null, null]);
		});

		it("passes active_only=false when explicitly set", async () => {
			let capturedParams: unknown[] | undefined;
			const queryFn = async <T>(_sql: string, params?: unknown[]) => {
				capturedParams = params;
				return { rows: [] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ active_only: false });

			assert.equal(capturedParams?.[0], false);
		});
	});

	describe("NO_ENABLED_ROUTE structured error", () => {
		it("returns NO_ENABLED_ROUTE with matching provider/tier when view is empty", async () => {
			const queryFn = async <T>() => ({ rows: [] as T[] });
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			const result = await handlers.listModels({
				provider: "vertexai",
				tier: "economy",
			});
			const payload = JSON.parse(textOf(result));

			assert.equal(payload.error, "NO_ENABLED_ROUTE");
			assert.equal(payload.provider, "vertexai");
			assert.equal(payload.tier, "economy");
			assert.match(payload.message, /provider=vertexai/);
			assert.match(payload.message, /tier=economy/);
		});

		it("returns null for provider and tier in NO_ENABLED_ROUTE when no filters used", async () => {
			const queryFn = async <T>() => ({ rows: [] as T[] });
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			const result = await handlers.listModels({});
			const payload = JSON.parse(textOf(result));

			assert.equal(payload.error, "NO_ENABLED_ROUTE");
			assert.equal(payload.provider, null);
			assert.equal(payload.tier, null);
		});

		it("omits filter description from message when no filters provided", async () => {
			const queryFn = async <T>() => ({ rows: [] as T[] });
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			const result = await handlers.listModels({});
			const payload = JSON.parse(textOf(result));

			assert.equal(payload.message, "No models with enabled routes found.");
		});
	});

	describe("SWR cache key isolation by project_id", () => {
		it("treats different project_ids as distinct cache keys", async () => {
			let queryCount = 0;
			const queryFn = async <T>() => {
				queryCount++;
				return { rows: [makeRow()] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ project_id: 1 });
			await handlers.listModels({ project_id: 2 });

			assert.equal(queryCount, 2);
		});

		it("serves same project_id from cache on second call", async () => {
			let queryCount = 0;
			const queryFn = async <T>() => {
				queryCount++;
				return { rows: [makeRow()] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ project_id: 42 });
			await handlers.listModels({ project_id: 42 });

			assert.equal(queryCount, 1);
			assert.equal(getModelListMetrics().cache_hit_total, 1);
		});

		it("treats (provider, tier) combo as part of the cache key", async () => {
			let queryCount = 0;
			const queryFn = async <T>() => {
				queryCount++;
				return { rows: [makeRow()] as T[] };
			};
			const handlers = new PgModelHandlers({} as never, "/tmp", queryFn as never);

			await handlers.listModels({ provider: "anthropic", tier: "frontier" });
			await handlers.listModels({ provider: "openai", tier: "frontier" });
			await handlers.listModels({ provider: "anthropic", tier: "economy" });

			assert.equal(queryCount, 3);
		});
	});

	describe("validateModelForDispatch pre-spawn guard", () => {
		it("returns valid=true when an enabled route exists", async () => {
			const queryFn = async <T>() => ({
				rows: [{ route_provider: "anthropic" }] as T[],
			});

			const result = await validateModelForDispatch(
				"claude-sonnet-4-6",
				undefined,
				queryFn as never,
			);

			assert.deepEqual(result, { valid: true });
		});

		it("returns NO_ENABLED_ROUTE when no enabled route exists", async () => {
			const queryFn = async <T>() => ({ rows: [] as T[] });

			const result = await validateModelForDispatch(
				"deprecated-model",
				undefined,
				queryFn as never,
			);

			assert.deepEqual(result, {
				valid: false,
				reason: "No enabled route found for model",
				error: "NO_ENABLED_ROUTE",
				model: "deprecated-model",
			});
		});

		it("accepts projectId parameter without throwing", async () => {
			const queryFn = async <T>() => ({
				rows: [{ route_provider: "anthropic" }] as T[],
			});

			const result = await validateModelForDispatch(
				"claude-sonnet-4-6",
				99,
				queryFn as never,
			);

			assert.equal(result.valid, true);
		});
	});
});
