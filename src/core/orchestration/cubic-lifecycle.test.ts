/**
 * Unit tests for P196 cubic lifecycle services.
 *
 * Uses injectable query/fs mocks — no real DB or filesystem required.
 */

import { describe, expect, test } from "bun:test";
import { CubicIdleDetector } from "./cubic-idle-detector.ts";
import {
	CubicCleanupService,
	type CubicCleanupFs,
	type QueryRunner,
} from "./cubic-cleanup.ts";

// ---------------------------------------------------------------------------
// Query stub helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeQuery(responses: Map<string, Row[]>): QueryRunner {
	return async (sql: string) => {
		for (const [fragment, rows] of responses) {
			if (sql.includes(fragment)) return { rows } as never;
		}
		return { rows: [] } as never;
	};
}

function captureQuery(): { captured: Array<{ sql: string; params: unknown[] }>; runner: QueryRunner } {
	const captured: Array<{ sql: string; params: unknown[] }> = [];
	const runner: QueryRunner = async (sql, params = []) => {
		captured.push({ sql, params });
		return { rows: [] } as never;
	};
	return { captured, runner };
}

// ---------------------------------------------------------------------------
// CubicIdleDetector tests
// ---------------------------------------------------------------------------

describe("CubicIdleDetector.detectIdleCubics", () => {
	test("returns cubic with last_activity_at older than 5 minutes", async () => {
		const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const mockRow = {
			cubic_id: "c-idle-1",
			lifecycle_status: "ACTIVE",
			last_activity_at: sixMinutesAgo,
			idle_since: null,
		};

		const q = makeQuery(
			new Map([["roadmap.cubic_state", [mockRow]]]),
		);
		const detector = new CubicIdleDetector({ query: q });

		const result = await detector.detectIdleCubics();

		expect(result).toHaveLength(1);
		expect(result[0].cubic_id).toBe("c-idle-1");
	});

	test("returns empty list when no idle cubics", async () => {
		const q = makeQuery(new Map([["roadmap.cubic_state", []]]));
		const detector = new CubicIdleDetector({ query: q });

		const result = await detector.detectIdleCubics();

		expect(result).toHaveLength(0);
	});
});

describe("CubicIdleDetector.detectStaleCubics", () => {
	test("returns cubic with last_activity_at older than 30 minutes", async () => {
		const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
		const mockRow = {
			cubic_id: "c-stale-1",
			lifecycle_status: "IDLE",
			last_activity_at: thirtyOneMinutesAgo,
			idle_since: thirtyOneMinutesAgo,
		};

		const q = makeQuery(
			new Map([["roadmap.cubic_state", [mockRow]]]),
		);
		const detector = new CubicIdleDetector({ query: q });

		const result = await detector.detectStaleCubics();

		expect(result).toHaveLength(1);
		expect(result[0].cubic_id).toBe("c-stale-1");
	});

	test("returns empty list when no stale cubics", async () => {
		const q = makeQuery(new Map([["roadmap.cubic_state", []]]));
		const detector = new CubicIdleDetector({ query: q });

		const result = await detector.detectStaleCubics();

		expect(result).toHaveLength(0);
	});
});

describe("CubicIdleDetector.updateActivity", () => {
	test("updates last_activity_at and lifecycle_status without touching phase", async () => {
		const { captured, runner } = captureQuery();
		const detector = new CubicIdleDetector({ query: runner });

		await detector.updateActivity("c-active-1");

		expect(captured).toHaveLength(1);
		const sql = captured[0].sql;

		expect(sql).toContain("last_activity_at = NOW()");
		expect(sql).toContain("lifecycle_status = 'ACTIVE'");
		expect(sql).toContain("idle_since = NULL");
		// Must NOT reset phase — callers own phase transitions
		expect(sql).not.toContain("phase = 'RUNNING'");
		expect(captured[0].params).toEqual(["c-active-1"]);
	});
});

// ---------------------------------------------------------------------------
// CubicCleanupService tests
// ---------------------------------------------------------------------------

function makeFs(existingPaths: Set<string>): CubicCleanupFs & { removed: string[] } {
	const removed: string[] = [];
	return {
		removed,
		exists: (path) => existingPaths.has(path),
		remove: async (path) => {
			existingPaths.delete(path);
			removed.push(path);
		},
		mkdir: async () => {},
		move: async () => {},
		gitStatus: async () => "",
		gitWorktreeRemove: async (path) => {
			existingPaths.delete(path);
			removed.push(path);
		},
	};
}

describe("CubicCleanupService.expireCubic", () => {
	test("marks cubic ARCHIVED in cubic_state", async () => {
		const { captured, runner } = captureQuery();
		const detector = new CubicIdleDetector({ query: runner });
		const cleanup = new CubicCleanupService({ query: runner, detector });

		await cleanup.expireCubic("c-expire-1");

		const archiveCall = captured.find(
			(c) => c.sql.includes("lifecycle_status = 'ARCHIVED'"),
		);
		expect(archiveCall).toBeDefined();
		expect(archiveCall?.params).toContain("c-expire-1");
	});

	test("marks cubic expired in cubics table", async () => {
		const { captured, runner } = captureQuery();
		const detector = new CubicIdleDetector({ query: runner });
		const cleanup = new CubicCleanupService({ query: runner, detector });

		await cleanup.expireCubic("c-expire-2");

		const expireCall = captured.find(
			(c) => c.sql.includes("status = 'expired'"),
		);
		expect(expireCall).toBeDefined();
		expect(expireCall?.params).toContain("c-expire-2");
	});
});

describe("CubicCleanupService.removeWorktree", () => {
	test("removes existing worktree directory", async () => {
		const worktreePath = "/data/code/worktree/test-agent";
		const existingPaths = new Set([worktreePath]);
		const fs = makeFs(existingPaths);

		const worktreeQueryResult: Row[] = [{ worktree_path: worktreePath }];
		const q = makeQuery(new Map([["roadmap.cubics", worktreeQueryResult]]));

		const cleanup = new CubicCleanupService({ query: q, fs });

		const removed = await cleanup.removeWorktree("c-remove-1");

		expect(removed).toBe(true);
		expect(fs.removed).toContain(worktreePath);
	});

	test("returns false when no directory exists", async () => {
		const fs = makeFs(new Set());
		const q = makeQuery(new Map([["roadmap.cubics", [{ worktree_path: null }]]]));
		const cleanup = new CubicCleanupService({ query: q, fs });

		const removed = await cleanup.removeWorktree("c-no-dir");

		expect(removed).toBe(false);
	});
});

describe("CubicCleanupService.cleanupStaleCubics", () => {
	test("dry run does not mutate anything", async () => {
		const { captured, runner } = captureQuery();

		const staleRow = {
			cubic_id: "c-stale-dry",
			lifecycle_status: "IDLE",
			last_activity_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
			idle_since: null,
		};

		const staleDetector = new CubicIdleDetector({
			query: makeQuery(new Map([["roadmap.cubic_state", [staleRow]]])),
		});

		const cleanup = new CubicCleanupService({
			query: runner,
			detector: staleDetector,
		});

		const report = await cleanup.cleanupStaleCubics({ dryRun: true });

		expect(report.total_stale).toBe(1);
		expect(report.expired).toBe(0);
		// No mutation queries should fire in dry-run
		expect(captured).toHaveLength(0);
	});

	test("expires stale cubics in live run", async () => {
		const mutations: string[] = [];
		const mutateRunner: QueryRunner = async (sql) => {
			mutations.push(sql);
			return { rows: [] } as never;
		};

		const staleRow = {
			cubic_id: "c-stale-live",
			lifecycle_status: "IDLE",
			last_activity_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
			idle_since: null,
		};

		const staleDetector = new CubicIdleDetector({
			query: makeQuery(new Map([["roadmap.cubic_state", [staleRow]]])),
		});
		const fs = makeFs(new Set());
		// Override query on cleanup to capture mutations while detector uses its own
		const worktreeQ: QueryRunner = async (sql) => {
			mutations.push(sql);
			return { rows: [{ worktree_path: null }] } as never;
		};

		const cleanup = new CubicCleanupService({
			query: worktreeQ,
			detector: staleDetector,
			fs,
		});

		const report = await cleanup.cleanupStaleCubics({ removeWorktrees: false });

		expect(report.expired).toBe(1);
	});
});
