import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import {
	type CubicCleanupFs,
	CubicCleanupService,
	checkCubicCreateBudget,
	type QueryRunner,
} from "../../src/core/orchestration/cubic-cleanup.ts";

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
	return {
		rows,
		rowCount: rows.length,
		command: "SELECT",
		oid: 0,
		fields: [],
	};
}

/**
 * FakeFs implements CubicCleanupFs for testing
 */
class FakeFs implements CubicCleanupFs {
	existing = new Set<string>();
	dirty = new Map<string, string>();
	removed: string[] = [];
	moved: Array<{ from: string; to: string }> = [];
	worktreeRemoved: string[] = [];
	mkdirs: string[] = [];

	async exists(path: string): Promise<boolean> {
		return this.existing.has(path);
	}

	async remove(path: string): Promise<void> {
		this.removed.push(path);
		this.existing.delete(path);
	}

	async mkdir(path: string): Promise<void> {
		this.mkdirs.push(path);
	}

	async move(from: string, to: string): Promise<void> {
		this.moved.push({ from, to });
		this.existing.delete(from);
		this.existing.add(to);
	}

	async gitStatus(path: string): Promise<string> {
		return this.dirty.get(path) ?? "";
	}

	async gitWorktreeRemove(path: string): Promise<void> {
		this.worktreeRemoved.push(path);
		this.existing.delete(path);
	}
}

describe("P527: Cubic Cleanup Reaper — Orphan Detection", () => {
	describe("Rule 1: No Active MCP Session", () => {
		test("AC1: Detects cubic with no active MCP slot and clean worktree", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-one-rule-1";
			fakeFs.existing.add(worktreePath);

			const queries: string[] = [];
			let mcpCheckCall = 0;

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				queries.push(sql);

				// First query: detect orphans
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-1",
							status: "active",
							phase: "build",
							agent_identity: "agent-one",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:01:00.000Z",
						},
					] as unknown as T[]);
				}

				// MCP slot check — simulates no active MCP slot
				if (sql.includes("mcp_registry") && sql.includes("endpoint_name")) {
					mcpCheckCall++;
					return result([{ exists: false }] as unknown as T[]);
				}

				// Default empty result
				return result([] as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const orphans = await service.detectOrphanCubics();

			assert.equal(orphans.length, 1);
			assert.equal(orphans[0].cubic_id, "cubic-rule-1");
			assert.equal(orphans[0].orphan_rule, 1);
			assert.equal(orphans[0].reason, "no_active_agent_slot");
			assert.ok(
				queries.some((q) => q.includes("mcp_registry")),
				"Should check MCP registry"
			);
		});

		test("AC1: Reaper deletes clean orphan (Rule 1) and logs to audit", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-one-rule-1-delete";
			fakeFs.existing.add(worktreePath);

			let auditInserted = false;
			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				// Detect orphans query
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-delete-1",
							status: "active",
							phase: "build",
							agent_identity: "agent-one",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:01:00.000Z",
						},
					] as unknown as T[]);
				}

				// MCP slot check
				if (sql.includes("mcp_registry") && sql.includes("endpoint_name")) {
					return result([{ exists: false }] as unknown as T[]);
				}

				// Proposal lease check (for lease release)
				if (sql.includes("proposal_lease") && sql.includes("UPDATE")) {
					return result([{ proposal_id: 999 }] as unknown as T[]);
				}

				// Audit insert
				if (sql.includes("INSERT INTO roadmap.cubic_cleanup_audit")) {
					auditInserted = true;
					return result([{ id: 1 }] as unknown as T[]);
				}

				// DELETE from cubics
				if (sql.includes("DELETE FROM roadmap.cubics")) {
					return result([] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const report = await service.reapOrphanCubics({ actor: "test-reaper" });

			assert.equal(report.deleted, 1);
			assert.ok(auditInserted, "Should insert audit entry");
			assert.ok(fakeFs.worktreeRemoved.length > 0, "Should remove worktree");
		});
	});

	describe("Rule 2: Stale Heartbeat (30+ min, no active MCP reference)", () => {
		test("AC2: Detects cubic with stale heartbeat and no active MCP reference", async () => {
			const fakeFs = new FakeFs();
			fakeFs.existing.add("/data/code/worktree/agent-two-stale");

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				// Detect orphans query
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-2-stale",
							status: "active",
							phase: "build",
							agent_identity: "agent-two",
							worktree_path: "/data/code/worktree/agent-two-stale",
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T11:29:00.000Z", // 31 minutes ago
						},
					] as unknown as T[]);
				}

				// MCP slot check (passes — slot exists but not referencing this cubic)
				if (
					sql.includes("mcp_registry") &&
					sql.includes("endpoint_name")
				) {
					return result([{ exists: true }] as unknown as T[]);
				}

				// MCP reference check (fails — no active reference)
				if (
					sql.includes("mcp_registry") &&
					sql.includes("current_cubic_id")
				) {
					return result([{ exists: false }] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const orphans = await service.detectOrphanCubics({
				staleMinutes: 30,
			});

			assert.equal(orphans.length, 1);
			assert.equal(orphans[0].orphan_rule, 2);
			assert.equal(orphans[0].reason, "stale_heartbeat_no_mcp_reference");
		});

		test("AC2: Preserves Rule 2 orphan if worktree is dirty", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-two-dirty";
			fakeFs.existing.add(worktreePath);
			fakeFs.dirty.set(worktreePath, "M src/file.ts\n");

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-2-dirty",
							status: "active",
							phase: "build",
							agent_identity: "agent-two",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T11:29:00.000Z",
						},
					] as unknown as T[]);
				}

				if (
					sql.includes("mcp_registry") &&
					sql.includes("endpoint_name")
				) {
					return result([{ exists: true }] as unknown as T[]);
				}

				if (
					sql.includes("mcp_registry") &&
					sql.includes("current_cubic_id")
				) {
					return result([{ exists: false }] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
				orphansRoot: "/data/code/orphans",
			});

			const report = await service.reapOrphanCubics({ actor: "test" });

			assert.equal(report.preserved, 1, "Should preserve dirty worktree");
			assert.ok(
				fakeFs.moved.some((m) => m.from === worktreePath),
				"Should move worktree to orphans"
			);
		});
	});

	describe("Rule 3: Closed Registry, Worktree Exists", () => {
		test("AC3: Detects completed cubic with lingering worktree", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-three-completed";
			fakeFs.existing.add(worktreePath);

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-3",
							status: "completed",
							phase: "done",
							agent_identity: "agent-three",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: "2026-05-01T12:04:00.000Z", // 6 minutes ago
							last_activity_at: "2026-05-01T12:04:00.000Z",
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const orphans = await service.detectOrphanCubics({
				closedGraceMinutes: 5,
			});

			assert.equal(orphans.length, 1);
			assert.equal(orphans[0].orphan_rule, 3);
			assert.equal(orphans[0].reason, "closed_registry_worktree_exists");
		});

		test("AC3: Cleans Rule 3 orphan by removing worktree", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-three-clean";
			fakeFs.existing.add(worktreePath);

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-3-clean",
							status: "completed",
							phase: "done",
							agent_identity: "agent-three",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: "2026-05-01T12:04:00.000Z",
							last_activity_at: "2026-05-01T12:04:00.000Z",
						},
					] as unknown as T[]);
				}

				if (sql.includes("DELETE FROM roadmap.cubics")) {
					return result([] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const report = await service.reapOrphanCubics({ actor: "test" });

			assert.equal(report.deleted, 1);
			assert.ok(
				fakeFs.worktreeRemoved.length > 0 ||
					fakeFs.removed.length > 0,
				"Should remove worktree"
			);
		});
	});

	describe("Rule 4: Active Registry, Worktree Missing", () => {
		test("AC4: Detects active cubic with missing worktree", async () => {
			const fakeFs = new FakeFs();
			// Worktree does NOT exist

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-4-missing",
							status: "active",
							phase: "build",
							agent_identity: "agent-four",
							worktree_path: "/data/code/worktree/agent-four-missing",
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:04:00.000Z",
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const orphans = await service.detectOrphanCubics({
				closedGraceMinutes: 5,
			});

			assert.equal(orphans.length, 1);
			assert.equal(orphans[0].orphan_rule, 4);
			assert.equal(
				orphans[0].reason,
				"active_registry_missing_worktree"
			);
		});

		test("AC4: Rule 4 orphan is marked orphaned (not deleted)", async () => {
			const fakeFs = new FakeFs();

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-rule-4-orphaned",
							status: "active",
							phase: "build",
							agent_identity: "agent-four",
							worktree_path: "/data/code/worktree/missing",
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:04:00.000Z",
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const report = await service.reapOrphanCubics({ actor: "test" });

			assert.equal(report.orphaned, 1);
			assert.equal(report.deleted, 0);
		});
	});

	describe("Budget Enforcement", () => {
		test("AC6: Reject cubic_create when budget exhausted", async () => {
			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				// host_model_policy query
				if (
					sql.includes("host_model_policy") &&
					!sql.includes("metadata")
				) {
					return result([
						{
							max_active: 2, // Max 2 cubics on this host
						},
					] as unknown as T[]);
				}

				// Active count query
				if (sql.includes("COUNT") && sql.includes("cubics")) {
					return result([
						{
							active_count: 2, // Already at max
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const status = await checkCubicCreateBudget({
				query,
				hostName: "test-host",
				defaultMaxActive: 2,
			});

			assert.equal(status.activeCount, 2);
			assert.equal(status.maxActive, 2);
			assert.equal(status.allowed, false);
		});

		test("AC6: Allow cubic_create when budget available", async () => {
			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (
					sql.includes("host_model_policy") &&
					!sql.includes("metadata")
				) {
					return result([
						{
							max_active: 10,
						},
					] as unknown as T[]);
				}

				if (sql.includes("COUNT") && sql.includes("cubics")) {
					return result([
						{
							active_count: 2, // Under limit
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const status = await checkCubicCreateBudget({
				query,
				hostName: "test-host",
				defaultMaxActive: 10,
			});

			assert.equal(status.activeCount, 2);
			assert.equal(status.maxActive, 10);
			assert.equal(status.allowed, true);
		});
	});

	describe("Lease Auto-Release", () => {
		test("AC7: Auto-release lease on stale cubic", async () => {
			const fakeFs = new FakeFs();
			fakeFs.existing.add("/data/code/worktree/agent-lease");

			let leaseReleased = false;

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
				params?: unknown[],
			): Promise<QueryResult<T>> => {
				// Lease release query (UPDATE roadmap_proposal.proposal_lease)
				if (sql.includes("UPDATE") && sql.includes("proposal_lease")) {
					leaseReleased = true;
					return result([
						{ proposal_id: 123 },
					] as unknown as T[]);
				}

				if (sql.includes("FROM roadmap.cubics c")) {
					return result([
						{
							cubic_id: "cubic-with-lease",
							status: "active",
							phase: "build",
							agent_identity: "agent-lease",
							worktree_path: "/data/code/worktree/agent-lease",
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T11:29:00.000Z", // 31 min ago
						},
					] as unknown as T[]);
				}

				if (
					sql.includes("mcp_registry") &&
					sql.includes("endpoint_name")
				) {
					return result([{ exists: true }] as unknown as T[]);
				}

				if (
					sql.includes("mcp_registry") &&
					sql.includes("current_cubic_id")
				) {
					return result([{ exists: false }] as unknown as T[]);
				}

				// Audit insert for lease release
				if (
					sql.includes("INSERT INTO roadmap.cubic_cleanup_audit") &&
					params?.[1] === "LEASE_RELEASED"
				) {
					return result([{ id: 1 }] as unknown as T[]);
				}

				// Generic audit insert
				if (sql.includes("INSERT INTO roadmap.cubic_cleanup_audit")) {
					return result([{ id: 1 }] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const report = await service.reapOrphanCubics({ actor: "test" });

			assert.ok(leaseReleased, "Should release lease");
			assert.equal(report.lease_releases, 1);
		});
	});

	describe("Manual Override", () => {
		test("AC8: Force-reap cubic bypasses detection rules", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-force";
			fakeFs.existing.add(worktreePath);

			let forceReapAuditLogged = false;
			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
				params?: unknown[],
			): Promise<QueryResult<T>> => {
				if (
					sql.includes("SELECT c.cubic_id") &&
					sql.includes("FOR UPDATE")
				) {
					return result([
						{
							cubic_id: "cubic-force-reap",
							status: "idle",
							phase: "design",
							agent_identity: "agent-force",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:09:00.000Z", // Only 1 min ago
						},
					] as unknown as T[]);
				}

				// Lease release query
				if (
					sql.includes("UPDATE roadmap_proposal.proposal_lease") &&
					sql.includes("RETURNING")
				) {
					return result([] as unknown as T[]);
				}

				// Force-reap audit insert (check params for "FORCE_REAP")
				if (
					sql.includes("INSERT INTO roadmap.cubic_cleanup_audit") &&
					params?.[1] === "FORCE_REAP"
				) {
					forceReapAuditLogged = true;
					return result([{ id: 1 }] as unknown as T[]);
				}

				// Generic audit insert
				if (sql.includes("INSERT INTO roadmap.cubic_cleanup_audit")) {
					return result([{ id: 1 }] as unknown as T[]);
				}

				// DELETE from cubics
				if (sql.includes("DELETE FROM roadmap.cubics")) {
					return result([] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
			});

			const result_ = await service.forceReapCubic({
				cubicId: "cubic-force-reap",
				reason: "testing",
				actor: "operator",
			});

			assert.equal(result_.cubic_id, "cubic-force-reap");
			assert.ok(forceReapAuditLogged, "Should log FORCE_REAP audit");
		});

		test("AC8: Manual override respects dirty worktree", async () => {
			const fakeFs = new FakeFs();
			const worktreePath = "/data/code/worktree/agent-force-dirty";
			fakeFs.existing.add(worktreePath);
			fakeFs.dirty.set(worktreePath, "A new-file.ts\n");

			const query: QueryRunner = async <T extends QueryResultRow>(
				sql: string,
			): Promise<QueryResult<T>> => {
				if (
					sql.includes("SELECT c.cubic_id") &&
					sql.includes("FOR UPDATE")
				) {
					return result([
						{
							cubic_id: "cubic-force-preserve",
							status: "active",
							phase: "build",
							agent_identity: "agent-force",
							worktree_path: worktreePath,
							created_at: "2026-05-01T12:00:00.000Z",
							activated_at: "2026-05-01T12:00:00.000Z",
							completed_at: null,
							last_activity_at: "2026-05-01T12:09:00.000Z",
						},
					] as unknown as T[]);
				}

				return result([] as unknown as T[]);
			};

			const service = new CubicCleanupService({
				query,
				fs: fakeFs,
				now: () => new Date("2026-05-01T12:10:00.000Z"),
				orphansRoot: "/data/code/orphans",
			});

			const result_ = await service.forceReapCubic({
				cubicId: "cubic-force-preserve",
				reason: "operator_testing",
				actor: "operator",
			});

			assert.equal(result_.action, "PRESERVED");
			assert.ok(result_.recovery_path, "Should have recovery path");
		});
	});
});
