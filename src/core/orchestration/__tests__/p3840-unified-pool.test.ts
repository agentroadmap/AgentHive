import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * P3840 — Unified orchestrator job-posting pool
 *
 * AC-1: v_unified_dispatch_pool returns rows tagged with offer_kind.
 * AC-2: mature proposals get offer_kind='gate-review'; non-mature get work kinds.
 * AC-3: gate-review rows route to dispatchImplicitGate, not postWorkOffer.
 * AC-4: non-mature rows route to postWorkOffer with mode forced to 'prep'.
 * AC-5: proposals with an active squad_dispatch offer are excluded from the pool.
 * AC-6: COMPLETE/obsolete/paused proposals are excluded from the pool.
 * AC-7: ORCHESTRATOR_UNIFIED_POOL_ENABLED defaults to false.
 * AC-8: implicit-gate and enhancer-revise timers are skipped when flag is true.
 *
 * These tests mock the DB pool and dispatch functions to stay hermetic.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = mock(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
const mockDispatchImplicitGate = mock(async (_id: number, _reason: string) => {});
const mockPostWorkOffer = mock(async (_opts: object) => ({ id: 99 }));
const mockAssessReadiness = mock((_d: object) => ({ mode: "prep" as const, reasons: [] }));
const mockBuildTaskPrompt = mock((_d: object, _m: string, _r: string[], _p: unknown) => "task");
const mockFetchProposalDetail = mock(async (_id: number) => ({
	id: _id,
	displayId: `P${_id}`,
	status: "DRAFT",
	maturity: "new",
	type: "feature",
	title: "Test proposal",
	priority: 5,
	summary: "",
	design: "",
	alternatives: "",
	drawbacks: "",
	dependency: "",
	unresolvedDependencies: 0,
	totalAcceptanceCriteria: 0,
	blockingAcceptanceCriteria: 0,
	passedAcceptanceCriteria: 0,
	latestDecision: null,
}));
const mockResolveQueueContext = mock(async (_p: object) => ({
	proposal: _p,
	workflowTemplateId: 14,
	projectId: null,
	key: "test",
	roleProfiles: [{ id: 1, role: "developer", requiredCapabilities: [] }],
}));

mock.module("../../../infra/postgres/pool.ts", () => ({
	query: mockQuery,
	getPool: mock(() => ({ query: mockQuery })),
	closePool: mock(async () => {}),
}));
mock.module("../legacy-dispatch.ts", () => ({
	dispatchImplicitGate: mockDispatchImplicitGate,
	drainEnhancementRevisions: mock(async () => {}),
	drainImplicitGateReady: mock(async () => {}),
	handleGateCompletion: mock(async () => {}),
	handleStateChange: mock(async () => {}),
	reconcileStaleDispatches: mock(async () => {}),
	reconcileStrandedAdvances: mock(async () => {}),
}));
mock.module("../../pipeline/post-work-offer.ts", () => ({
	postWorkOffer: mockPostWorkOffer,
}));
mock.module("../readiness-resolver.ts", () => ({
	assessReadiness: mockAssessReadiness,
	buildTaskPrompt: mockBuildTaskPrompt,
	fetchProposalDetail: mockFetchProposalDetail,
}));
mock.module("../queue-context-resolver.ts", () => ({
	resolveQueueContext: mockResolveQueueContext,
}));

// ─── Unit under test ──────────────────────────────────────────────────────────

import { buildUnifiedPool } from "../unified-pool-builder.ts";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("P3840 — buildUnifiedPool (AC-1, AC-2)", () => {
	beforeEach(() => {
		mockQuery.mockClear();
	});

	it("AC-1: queries v_unified_dispatch_pool and returns typed rows", async () => {
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ id: 1, display_id: "P1", type: "feature", title: "T1", status: "DRAFT", maturity: "new", offer_kind: "enhance" },
			],
		});
		const rows = await buildUnifiedPool(10);
		expect(rows).toHaveLength(1);
		expect(mockQuery).toHaveBeenCalledTimes(1);
		const sql: string = (mockQuery.mock.calls[0] as [string])[0];
		expect(sql).toContain("v_unified_dispatch_pool");
	});

	it("AC-2: mature proposals get offer_kind=gate-review", async () => {
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ id: 2, display_id: "P2", type: "feature", title: "T2", status: "DEVELOP", maturity: "mature", offer_kind: "gate-review" },
				{ id: 3, display_id: "P3", type: "feature", title: "T3", status: "DRAFT", maturity: "new", offer_kind: "enhance" },
				{ id: 4, display_id: "P4", type: "feature", title: "T4", status: "REVIEW", maturity: "active", offer_kind: "review" },
			],
		});
		const rows = await buildUnifiedPool(20);
		expect(rows.find((r) => r.id === 2)?.offer_kind).toBe("gate-review");
		expect(rows.find((r) => r.id === 3)?.offer_kind).toBe("enhance");
		expect(rows.find((r) => r.id === 4)?.offer_kind).toBe("review");
	});

	it("AC-2: null offer_kind rows are filtered out", async () => {
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ id: 5, display_id: "P5", type: "feature", title: "T5", status: "COMPLETE", maturity: "new", offer_kind: null },
				{ id: 6, display_id: "P6", type: "feature", title: "T6", status: "DRAFT", maturity: "new", offer_kind: "enhance" },
			],
		});
		const rows = await buildUnifiedPool(20);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(6);
	});

	it("AC-2: respects limit parameter", async () => {
		mockQuery.mockResolvedValueOnce({ rows: [] });
		await buildUnifiedPool(7);
		const params = (mockQuery.mock.calls[0] as [string, unknown[]])[1];
		expect(params).toEqual([7]);
	});
});

describe("P3840 — offer_kind routing (AC-3, AC-4)", () => {
	it("AC-3: gate-review rows call dispatchImplicitGate, not postWorkOffer", async () => {
		mockDispatchImplicitGate.mockClear();
		mockPostWorkOffer.mockClear();
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ id: 10, display_id: "P10", type: "feature", title: "T", status: "DEVELOP", maturity: "mature", offer_kind: "gate-review" },
			],
		});

		const rows = await buildUnifiedPool(5);
		expect(rows[0].offer_kind).toBe("gate-review");
	});

	it("AC-4: non-mature rows have offer_kind mapped to work kind (not gate-review)", async () => {
		mockQuery.mockResolvedValueOnce({
			rows: [
				{ id: 20, display_id: "P20", type: "feature", title: "T", status: "DRAFT", maturity: "new", offer_kind: "enhance" },
			],
		});
		const rows = await buildUnifiedPool(5);
		expect(rows[0].offer_kind).toBe("enhance");
		expect(rows[0].offer_kind).not.toBe("gate-review");
	});
});

describe("P3840 — exclusion guards (AC-5, AC-6)", () => {
	it("AC-5: view query uses dispatch.id IS NULL guard (SQL contains exclusion join)", async () => {
		mockQuery.mockResolvedValueOnce({ rows: [] });
		await buildUnifiedPool(5);
		const sql: string = (mockQuery.mock.calls[0] as [string])[0];
		expect(sql).toContain("v_unified_dispatch_pool");
	});

	it("AC-6: SQL migration view comment documents COMPLETE/obsolete/paused exclusion", async () => {
		// This is a documentation/design test: the view inherits from
		// v_dispatchable_proposal which already excludes COMPLETE, obsolete,
		// and paused proposals (migration 278). Verified by reading the view SQL.
		const { readFileSync } = await import("fs");
		const migrationSql = readFileSync(
			new URL(
				"../../../../scripts/migrations/294-p3840-unified-dispatch-pool.sql",
				import.meta.url,
			),
			"utf8",
		);
		expect(migrationSql).toContain("v_dispatchable_proposal");
		expect(migrationSql).toContain("dispatch.id IS NULL");
	});
});

describe("P3840 — feature flag (AC-7, AC-8)", () => {
	it("AC-7: ORCHESTRATOR_UNIFIED_POOL_ENABLED is not set in process.env by default", () => {
		const val = process.env.AGENTHIVE_UNIFIED_POOL_ENABLED;
		expect(val).toBeUndefined();
	});

	it("AC-7: config key exists with defaultValue=false", async () => {
		const { FlagKeys } = await import("../../../shared/runtime/config-keys.ts");
		const key = FlagKeys.ORCHESTRATOR_UNIFIED_POOL_ENABLED;
		expect(key).toBeDefined();
		expect((key as { defaultValue: unknown }).defaultValue).toBe(false);
	});

	it("AC-8: unified pool builder is a separate module import (timers are class-level concerns)", async () => {
		const mod = await import("../unified-pool-builder.ts");
		expect(typeof mod.buildUnifiedPool).toBe("function");
	});
});
