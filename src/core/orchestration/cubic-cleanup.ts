/**
 * Cubic Cleanup Service (P196)
 *
 * Handles cleanup of stale cubics:
 * 1. Expires cubics in the cubics table (status → 'expired')
 * 2. Archives cubic_state rows (lifecycle_status → 'ARCHIVED')
 * 3. Removes worktree directories (optional)
 * 4. Logs cleanup actions to audit_log
 *
 * Worktree paths follow: /data/code/worktree/<agent-identity>
 * or /data/code/.claude/cubics/<cubic-id>
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { QueryResult, QueryResultRow } from "pg";
import { query } from "../../infra/postgres/pool.ts";
import { getWorktreeRoot } from "../../shared/runtime/paths.ts";
import { CubicIdleDetector } from "./cubic-idle-detector.ts";

const execFileAsync = promisify(execFile);

export interface CleanupReport {
	timestamp: Date;
	total_stale: number;
	expired: number;
	worktrees_removed: number;
	errors: string[];
}

export type OrphanRule = 1 | 2 | 3 | 4 | "force";
export type ReapAction = "DELETED" | "PRESERVED" | "ORPHANED" | "DRY_RUN";

export interface CubicCleanupAuditEntry {
	cubic_id: string;
	action:
		| "PRESERVED"
		| "DELETED"
		| "LEASE_RELEASED"
		| "FORCE_REAP"
		| "ORPHANED";
	orphan_rule: number | null;
	reason: string;
	recovery_path: string | null;
	worktree_path: string | null;
	actor: string;
	proposal_id?: number | null;
}

export interface OrphanCubic {
	cubic_id: string;
	status: string;
	phase: string | null;
	agent_identity: string | null;
	worktree_path: string | null;
	created_at: string;
	activated_at: string | null;
	completed_at: string | null;
	last_activity_at: string | null;
	orphan_rule: OrphanRule;
	reason: string;
}

export interface ReapResult {
	cubic_id: string;
	action: ReapAction;
	orphan_rule: OrphanRule;
	reason: string;
	worktree_path: string | null;
	recovery_path: string | null;
	dirty: boolean;
	lease_release_count: number;
}

export interface P526CleanupReport {
	timestamp: Date;
	total_orphans: number;
	deleted: number;
	preserved: number;
	orphaned: number;
	dry_run: number;
	lease_releases: number;
	results: ReapResult[];
	errors: string[];
}

export type QueryRunner = <T extends QueryResultRow = QueryResultRow>(
	text: string,
	params?: unknown[],
) => Promise<QueryResult<T>>;

export interface CubicCleanupFs {
	exists(path: string): boolean | Promise<boolean>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
	gitStatus(path: string): Promise<string>;
	gitWorktreeRemove(path: string): Promise<void>;
}

export interface CubicCleanupServiceOptions {
	query?: QueryRunner;
	fs?: CubicCleanupFs;
	detector?: CubicIdleDetector;
	orphansRoot?: string;
	now?: () => Date;
}

export const DEFAULT_MAX_ACTIVE_CUBICS_PER_HOST = 10;

export interface CubicBudgetStatus {
	hostName: string;
	activeCount: number;
	maxActive: number;
	allowed: boolean;
}

export interface CubicBudgetOptions {
	query: QueryRunner;
	hostName?: string;
	worktreeRoot?: string;
	defaultMaxActive?: number;
}

const defaultFs: CubicCleanupFs = {
	exists: (path) => existsSync(path),
	remove: (path) => rm(path, { recursive: true, force: true }),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	move: async (from, to) => {
		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);
	},
	gitStatus: async (path) => {
		const { stdout } = await execFileAsync(
			"git",
			["-C", path, "status", "--short"],
			{
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			},
		);
		return stdout;
	},
	gitWorktreeRemove: async (path) => {
		await execFileAsync("git", ["worktree", "remove", "--force", path], {
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
	},
};

export function resolveCubicHostName(
	env: Partial<Pick<NodeJS.ProcessEnv, "AGENTHIVE_HOST">> = process.env,
	fallbackHost = hostname(),
): string {
	return env.AGENTHIVE_HOST?.trim() || fallbackHost;
}

export async function checkCubicCreateBudget(
	options: CubicBudgetOptions,
): Promise<CubicBudgetStatus> {
	const hostName = options.hostName ?? resolveCubicHostName();
	const worktreeRoot = options.worktreeRoot ?? getWorktreeRoot();
	const defaultMaxActive =
		options.defaultMaxActive ?? DEFAULT_MAX_ACTIVE_CUBICS_PER_HOST;

	const maxActive = await readMaxActiveCubicsPerHost(
		options.query,
		hostName,
		defaultMaxActive,
	);
	const activeCount = await countActiveCubicsForHost(
		options.query,
		hostName,
		worktreeRoot,
	);

	return {
		hostName,
		activeCount,
		maxActive,
		allowed: activeCount < maxActive,
	};
}

export class CubicCleanupService {
	private readonly detector: CubicIdleDetector;
	private readonly query: QueryRunner;
	private readonly fs: CubicCleanupFs;
	private readonly orphansRoot: string;
	private readonly now: () => Date;

	constructor(options: CubicCleanupServiceOptions = {}) {
		this.query = options.query ?? query;
		this.fs = options.fs ?? defaultFs;
		this.detector = options.detector ?? new CubicIdleDetector();
		this.orphansRoot =
			options.orphansRoot ??
			process.env.AGENTHIVE_CUBIC_ORPHANS_ROOT ??
			"/data/code/orphans";
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * Full cleanup run: detect stale cubics → expire → archive → remove worktrees.
	 */
	async cleanupStaleCubics(options?: {
		removeWorktrees?: boolean;
		dryRun?: boolean;
	}): Promise<CleanupReport> {
		const removeWorktrees = options?.removeWorktrees ?? true;
		const dryRun = options?.dryRun ?? false;

		const staleCubics = await this.detector.detectStaleCubics();

		const report: CleanupReport = {
			timestamp: new Date(),
			total_stale: staleCubics.length,
			expired: 0,
			worktrees_removed: 0,
			errors: [],
		};

		for (const cubic of staleCubics) {
			try {
				if (!dryRun) {
					await this.expireCubic(cubic.cubic_id);
					report.expired++;

					if (removeWorktrees) {
						const removed = await this.removeWorktree(cubic.cubic_id);
						if (removed) report.worktrees_removed++;
					}
				}
			} catch (err) {
				report.errors.push(
					`Failed to cleanup ${cubic.cubic_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return report;
	}

	/**
	 * Expire a single cubic: mark expired in cubics, ARCHIVED in cubic_state.
	 */
	async expireCubic(cubicId: string): Promise<void> {
		// Mark expired in main cubics table
		await this.query(
			`UPDATE roadmap.cubics
			 SET status = 'expired',
			     completed_at = COALESCE(completed_at, NOW())
			 WHERE cubic_id = $1
			   AND status NOT IN ('expired', 'complete')`,
			[cubicId],
		);

		// Mark ARCHIVED in cubic_state
		await this.detector.markArchived(cubicId);

		// Release any active leases for this cubic
		await this.query(
			`UPDATE roadmap.cubics
			 SET lock_holder = NULL,
			     lock_phase = NULL,
			     locked_at = NULL
			 WHERE cubic_id = $1`,
			[cubicId],
		);

		// Audit log — 'delete' is the closest valid action for expiry
		await this.query(
			`INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by)
			 VALUES ('cubic', $1, 'delete', 'cubic-cleanup-service')`,
			[cubicId],
		);
	}

	/**
	 * Remove worktree directory for a cubic.
	 * Checks multiple possible paths:
	 * - /data/code/worktree/<agent-identity> (from cubics.worktree_path)
	 * - /data/code/.claude/cubics/<cubic-id> (legacy)
	 */
	async removeWorktree(cubicId: string): Promise<boolean> {
		// Get worktree path from cubics table
		const { rows } = await this.query<{ worktree_path: string | null }>(
			`SELECT worktree_path FROM roadmap.cubics WHERE cubic_id = $1`,
			[cubicId],
		);

		const paths: string[] = [];

		if (rows[0]?.worktree_path) {
			paths.push(rows[0].worktree_path);
		}

		// Also check legacy path
		paths.push(`/data/code/.claude/cubics/${cubicId}`);

		let removed = false;
		for (const path of paths) {
			if (await this.fs.exists(path)) {
				try {
					await this.fs.remove(path);
					removed = true;
				} catch {
					// Non-fatal — directory may be in use or permissions issue
				}
			}
		}

		return removed;
	}

	/**
	 * Mark completed cubics in cubic_state.
	 * Syncs from cubics.status = 'complete'.
	 */
	async syncCompletedCubics(): Promise<number> {
		const { rows } = await this.query<{ cubic_id: string }>(
			`UPDATE roadmap.cubic_state cs
			 SET lifecycle_status = 'COMPLETED',
			     phase = 'COMPLETED'
			 FROM roadmap.cubics c
			 WHERE cs.cubic_id = c.cubic_id
			   AND c.status = 'complete'
			   AND cs.lifecycle_status NOT IN ('COMPLETED', 'ARCHIVED')
			 RETURNING cs.cubic_id`,
		);

		return rows.length;
	}

	/**
	 * Run the full idle detection → mark idle cycle.
	 */
	async markIdleCubics(): Promise<number> {
		const idleCubics = await this.detector.detectIdleCubics();

		for (const cubic of idleCubics) {
			await this.detector.markIdle(cubic.cubic_id);
		}

		return idleCubics.length;
	}

	/**
	 * Bulk-expire old cubics by age (regardless of cubic_state).
	 * Catches cubics that predate the cubic_state table.
	 */
	async expireOldCubics(olderThanMinutes = 60): Promise<number> {
		const { rows } = await this.query<{ cubic_id: string }>(
			`UPDATE roadmap.cubics
			 SET status = 'expired',
			     completed_at = COALESCE(completed_at, NOW())
			 WHERE status NOT IN ('expired', 'complete')
			   AND created_at < NOW() - ($1 || ' minutes')::interval
			 RETURNING cubic_id`,
			[olderThanMinutes.toString()],
		);

		// Sync cubic_state for expired cubics
		for (const row of rows) {
			await this.detector.markArchived(row.cubic_id);
		}

		return rows.length;
	}

	/**
	 * P526: Classify open/terminal cubic registry drift without touching disk.
	 */
	async detectOrphanCubics(options?: {
		idleMinutes?: number;
		staleMinutes?: number;
		closedGraceMinutes?: number;
		limit?: number;
	}): Promise<OrphanCubic[]> {
		const idleMinutes = options?.idleMinutes ?? 5;
		const staleMinutes = options?.staleMinutes ?? 30;
		const closedGraceMinutes = options?.closedGraceMinutes ?? 5;
		const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
		const now = this.now();

		const { rows } = await this.query<{
			cubic_id: string;
			status: string;
			phase: string | null;
			agent_identity: string | null;
			worktree_path: string | null;
			created_at: string;
			activated_at: string | null;
			completed_at: string | null;
			last_activity_at: string | null;
		}>(
			`SELECT c.cubic_id, c.status, c.phase, c.agent_identity, c.worktree_path,
			        c.created_at::text, c.activated_at::text, c.completed_at::text,
			        cs.last_activity_at::text
			   FROM roadmap.cubics c
			   LEFT JOIN roadmap.cubic_state cs ON cs.cubic_id = c.cubic_id
			  WHERE c.status NOT IN ('terminated', 'recycled')
			  ORDER BY COALESCE(cs.last_activity_at, c.activated_at, c.created_at) ASC
			  LIMIT $1`,
			[limit],
		);

		const classified: OrphanCubic[] = [];
		for (const row of rows) {
			const cubic = await this.classifyCandidate(row, {
				now,
				idleMinutes,
				staleMinutes,
				closedGraceMinutes,
			});
			if (cubic) classified.push(cubic);
		}
		return classified;
	}

	/**
	 * P526: Run orphan detection and apply preserve/delete/orphan registry actions.
	 */
	async reapOrphanCubics(options?: {
		dryRun?: boolean;
		actor?: string;
		limit?: number;
	}): Promise<P526CleanupReport> {
		const actor = options?.actor ?? "cubic-cleanup-service";
		const dryRun = options?.dryRun ?? false;
		const orphans = await this.detectOrphanCubics({ limit: options?.limit });
		const report: P526CleanupReport = {
			timestamp: this.now(),
			total_orphans: orphans.length,
			deleted: 0,
			preserved: 0,
			orphaned: 0,
			dry_run: 0,
			lease_releases: 0,
			results: [],
			errors: [],
		};

		for (const orphan of orphans) {
			try {
				const result = await this.reapCubic(orphan, { dryRun, actor });
				report.results.push(result);
				report.lease_releases += result.lease_release_count;
				if (result.action === "DELETED") report.deleted++;
				if (result.action === "PRESERVED") report.preserved++;
				if (result.action === "ORPHANED") report.orphaned++;
				if (result.action === "DRY_RUN") report.dry_run++;
			} catch (err) {
				report.errors.push(
					`Failed to reap ${orphan.cubic_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return report;
	}

	/**
	 * P526 manual override: bypass detection, classify the named cubic as force-reap.
	 */
	async forceReapCubic(args: {
		cubicId: string;
		reason: string;
		actor?: string;
		dryRun?: boolean;
	}): Promise<ReapResult> {
		const { rows } = await this.query<{
			cubic_id: string;
			status: string;
			phase: string | null;
			agent_identity: string | null;
			worktree_path: string | null;
			created_at: string;
			activated_at: string | null;
			completed_at: string | null;
			last_activity_at: string | null;
		}>(
			`SELECT c.cubic_id, c.status, c.phase, c.agent_identity, c.worktree_path,
			        c.created_at::text, c.activated_at::text, c.completed_at::text,
			        cs.last_activity_at::text
			   FROM roadmap.cubics c
			   LEFT JOIN roadmap.cubic_state cs ON cs.cubic_id = c.cubic_id
			  WHERE c.cubic_id = $1
			  FOR UPDATE OF c`,
			[args.cubicId],
		);
		if (!rows.length) throw new Error(`Cubic ${args.cubicId} not found`);

		return this.reapCubic(
			{
				...rows[0],
				orphan_rule: "force",
				reason: args.reason,
			},
			{
				dryRun: args.dryRun ?? false,
				actor: args.actor ?? "manual-operator",
				force: true,
			},
		);
	}

	private async classifyCandidate(
		row: Omit<OrphanCubic, "orphan_rule" | "reason">,
		options: {
			now: Date;
			idleMinutes: number;
			staleMinutes: number;
			closedGraceMinutes: number;
		},
	): Promise<OrphanCubic | null> {
		const status = row.status;
		const activeLike = status === "active" || status === "idle";
		const closedLike =
			status === "complete" || status === "completed" || status === "expired";
		const worktreeExists = row.worktree_path
			? await this.fs.exists(row.worktree_path)
			: false;
		const activatedAt = new Date(row.activated_at ?? row.created_at);
		const lastActivityAt = row.last_activity_at
			? new Date(row.last_activity_at)
			: activatedAt;
		const completedAt = row.completed_at
			? new Date(row.completed_at)
			: activatedAt;

		if (
			activeLike &&
			!worktreeExists &&
			minutesBetween(activatedAt, options.now) >= options.closedGraceMinutes
		) {
			return {
				...row,
				orphan_rule: 4,
				reason: "active_registry_missing_worktree",
			};
		}

		if (
			closedLike &&
			worktreeExists &&
			minutesBetween(completedAt, options.now) >= options.closedGraceMinutes
		) {
			return {
				...row,
				orphan_rule: 3,
				reason: "closed_registry_worktree_exists",
			};
		}

		if (
			activeLike &&
			minutesBetween(lastActivityAt, options.now) >= options.staleMinutes &&
			!(await this.hasActiveMcpReference(row.cubic_id))
		) {
			return {
				...row,
				orphan_rule: 2,
				reason: "stale_heartbeat_no_mcp_reference",
			};
		}

		if (
			activeLike &&
			row.agent_identity &&
			minutesBetween(activatedAt, options.now) >= options.idleMinutes &&
			!(await this.hasActiveMcpSlot(row.cubic_id, row.agent_identity))
		) {
			return {
				...row,
				orphan_rule: 1,
				reason: "no_active_agent_slot",
			};
		}

		return null;
	}

	private async reapCubic(
		orphan: OrphanCubic,
		options: { dryRun: boolean; actor: string; force?: boolean },
	): Promise<ReapResult> {
		const exists = orphan.worktree_path
			? await this.fs.exists(orphan.worktree_path)
			: false;
		const dirty =
			exists && orphan.worktree_path
				? (await this.fs.gitStatus(orphan.worktree_path)).trim().length > 0
				: false;

		if (options.dryRun) {
			return {
				cubic_id: orphan.cubic_id,
				action: "DRY_RUN",
				orphan_rule: orphan.orphan_rule,
				reason: orphan.reason,
				worktree_path: orphan.worktree_path,
				recovery_path: null,
				dirty,
				lease_release_count: 0,
			};
		}

		const leaseReleaseCount = await this.releaseCubicLeases(
			orphan.cubic_id,
			orphan.reason,
			options.actor,
		);

		if (dirty && orphan.worktree_path) {
			const recoveryPath = this.recoveryPath(orphan.cubic_id);
			await this.fs.mkdir(this.orphansRoot);
			await this.fs.move(orphan.worktree_path, recoveryPath);
			await this.query(
				`UPDATE roadmap.cubics
				    SET status = 'orphaned',
				        worktree_path = $2,
				        lock_holder = NULL,
				        lock_phase = NULL,
				        locked_at = NULL,
				        completed_at = COALESCE(completed_at, NOW())
				  WHERE cubic_id = $1`,
				[orphan.cubic_id, recoveryPath],
			);
			await this.writeAudit({
				cubic_id: orphan.cubic_id,
				action: options.force ? "FORCE_REAP" : "PRESERVED",
				orphan_rule: orphan.orphan_rule === "force" ? null : orphan.orphan_rule,
				reason: orphan.reason,
				recovery_path: recoveryPath,
				worktree_path: orphan.worktree_path,
				actor: options.actor,
			});
			return {
				cubic_id: orphan.cubic_id,
				action: "PRESERVED",
				orphan_rule: orphan.orphan_rule,
				reason: orphan.reason,
				worktree_path: orphan.worktree_path,
				recovery_path: recoveryPath,
				dirty,
				lease_release_count: leaseReleaseCount,
			};
		}

		if (orphan.orphan_rule === 4 && !options.force) {
			await this.query(
				`UPDATE roadmap.cubics
				    SET status = 'orphaned',
				        lock_holder = NULL,
				        lock_phase = NULL,
				        locked_at = NULL,
				        completed_at = COALESCE(completed_at, NOW())
				  WHERE cubic_id = $1`,
				[orphan.cubic_id],
			);
			await this.writeAudit({
				cubic_id: orphan.cubic_id,
				action: "ORPHANED",
				orphan_rule: 4,
				reason: orphan.reason,
				recovery_path: null,
				worktree_path: orphan.worktree_path,
				actor: options.actor,
			});
			return {
				cubic_id: orphan.cubic_id,
				action: "ORPHANED",
				orphan_rule: orphan.orphan_rule,
				reason: orphan.reason,
				worktree_path: orphan.worktree_path,
				recovery_path: null,
				dirty,
				lease_release_count: leaseReleaseCount,
			};
		}

		if (exists && orphan.worktree_path) {
			try {
				await this.fs.gitWorktreeRemove(orphan.worktree_path);
			} catch {
				await this.fs.remove(orphan.worktree_path);
			}
		}
		await this.query(`DELETE FROM roadmap.cubics WHERE cubic_id = $1`, [
			orphan.cubic_id,
		]);
		await this.writeAudit({
			cubic_id: orphan.cubic_id,
			action: options.force ? "FORCE_REAP" : "DELETED",
			orphan_rule: orphan.orphan_rule === "force" ? null : orphan.orphan_rule,
			reason: orphan.reason,
			recovery_path: null,
			worktree_path: orphan.worktree_path,
			actor: options.actor,
		});

		return {
			cubic_id: orphan.cubic_id,
			action: "DELETED",
			orphan_rule: orphan.orphan_rule,
			reason: orphan.reason,
			worktree_path: orphan.worktree_path,
			recovery_path: null,
			dirty,
			lease_release_count: leaseReleaseCount,
		};
	}

	private async hasActiveMcpSlot(
		cubicId: string,
		agentIdentity: string,
	): Promise<boolean> {
		const { rows } = await this.query<{ exists: boolean }>(
			`SELECT EXISTS (
			     SELECT 1
			       FROM roadmap.mcp_registry
			      WHERE is_active = true
			        AND endpoint_name = $1
			   ) AS exists`,
			[`${cubicId}:${agentIdentity}`],
		);
		return rows[0]?.exists === true;
	}

	private async hasActiveMcpReference(cubicId: string): Promise<boolean> {
		const { rows } = await this.query<{ exists: boolean }>(
			`SELECT EXISTS (
			     SELECT 1
			       FROM roadmap.mcp_registry
			      WHERE is_active = true
			        AND metadata->>'current_cubic_id' = $1
			   ) AS exists`,
			[cubicId],
		);
		return rows[0]?.exists === true;
	}

	private async releaseCubicLeases(
		cubicId: string,
		reason: string,
		actor: string,
	): Promise<number> {
		// P934: replaced free-text 'cubic_stale_timeout: ${reason}' with
		// canonical 'lease_expired'. The cubic-specific context (the
		// passed-in `reason` string) is preserved in the writeAudit call
		// below, where prose belongs. release_reason itself is a short
		// canonical enum value.
		const { rows } = await this.query<{ proposal_id: number }>(
			`UPDATE roadmap_proposal.proposal_lease pl
			    SET released_at = NOW(),
			        release_reason = 'lease_expired'
			   FROM roadmap.cubics c
			  WHERE c.cubic_id = $1
			    AND pl.released_at IS NULL
			    AND pl.agent_identity = COALESCE(c.lock_holder, c.agent_identity)
			  RETURNING pl.proposal_id`,
			[cubicId],
		);
		for (const row of rows) {
			await this.writeAudit({
				cubic_id: cubicId,
				action: "LEASE_RELEASED",
				orphan_rule: null,
				reason: "cubic_stale_timeout",
				recovery_path: null,
				worktree_path: null,
				actor,
				proposal_id: row.proposal_id,
			});
		}
		return rows.length;
	}

	private async writeAudit(entry: CubicCleanupAuditEntry): Promise<void> {
		await this.query(
			`INSERT INTO roadmap.cubic_cleanup_audit
			   (cubic_id, action, orphan_rule, reason, recovery_path, worktree_path, actor, proposal_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				entry.cubic_id,
				entry.action,
				entry.orphan_rule,
				entry.reason,
				entry.recovery_path,
				entry.worktree_path,
				entry.actor,
				entry.proposal_id ?? null,
			],
		);
	}

	private recoveryPath(cubicId: string): string {
		const stamp = this.now().toISOString().replace(/[:.]/g, "-");
		return join(this.orphansRoot, `${cubicId}-${stamp}`);
	}
}

async function readMaxActiveCubicsPerHost(
	queryRunner: QueryRunner,
	hostName: string,
	defaultMaxActive: number,
): Promise<number> {
	const { rows } = await queryRunner<{ max_active: number | string }>(
		`SELECT COALESCE(
		          CASE
		            WHEN metadata ? 'max_active_cubics_per_host'
		             AND metadata->>'max_active_cubics_per_host' ~ '^[0-9]+$'
		            THEN (metadata->>'max_active_cubics_per_host')::int
		          END,
		          $2::int
		        ) AS max_active
		   FROM roadmap.host_model_policy
		  WHERE host_name = $1`,
		[hostName, defaultMaxActive],
	);
	const configured = Number(rows[0]?.max_active ?? defaultMaxActive);
	return Number.isFinite(configured)
		? Math.max(0, Math.floor(configured))
		: defaultMaxActive;
}

async function countActiveCubicsForHost(
	queryRunner: QueryRunner,
	hostName: string,
	worktreeRoot: string,
): Promise<number> {
	const { rows } = await queryRunner<{ active_count: number | string }>(
		`SELECT COUNT(*)::int AS active_count
		   FROM roadmap.cubics
		  WHERE status NOT IN ('completed', 'complete', 'expired', 'terminated', 'recycled', 'orphaned')
		    AND COALESCE(
		          metadata->>'host_name',
		          CASE WHEN worktree_path LIKE $2 ESCAPE '\\' THEN $1 ELSE NULL END
		        ) = $1`,
		[hostName, `${escapeLike(worktreeRoot.replace(/\/+$/, ""))}/%`],
	);
	return Number(rows[0]?.active_count ?? 0);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

function minutesBetween(from: Date, to: Date): number {
	return (to.getTime() - from.getTime()) / 60_000;
}
