#!/usr/bin/env -S bun run
// Cubic Lifecycle Cron Job (P196)
//
// Periodic maintenance for cubic lifecycle management:
//   1. Sync cubic_state from cubics table (fix drift)
//   2. Mark idle cubics (ACTIVE → IDLE after 5 min inactivity)
//   3. Sync completed cubics (COMPLETED status)
//   4. Expire stale cubics (IDLE/COMPLETED for 30+ min → ARCHIVED)
//   5. Expire very old cubics (any status, 60+ min old → expired)
//
// Run via crontab or systemd timer (every 15 minutes):
//   */15 * * * * cd /data/code/AgentHive && bun run scripts/cubic-lifecycle-cron.ts
//
// Or as a one-shot:
//   bun run scripts/cubic-lifecycle-cron.ts [--dry-run] [--no-worktree-cleanup]

import { CubicIdleDetector } from "../src/core/orchestration/cubic-idle-detector.ts";
import { CubicCleanupService } from "../src/core/orchestration/cubic-cleanup.ts";
import { reapOrphanScratch } from "../src/shared/utils/agent-scratch.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const removeWorktrees = !args.has("--no-worktree-cleanup");

async function main() {
	const detector = new CubicIdleDetector();
	const cleanup = new CubicCleanupService();

	console.log(`[cubic-lifecycle] Starting cleanup run${dryRun ? " (DRY RUN)" : ""}`);

	// Step 1: Sync cubic_state from cubics table
	const synced = await detector.syncFromCubics();
	if (synced > 0) {
		console.log(`[cubic-lifecycle] Synced ${synced} cubic_state rows from cubics`);
	}

	// Step 2: Mark idle cubics
	const idled = await cleanup.markIdleCubics();
	if (idled > 0) {
		console.log(`[cubic-lifecycle] Marked ${idled} cubics as IDLE`);
	}

	// Step 3: Sync completed cubics
	const completed = await cleanup.syncCompletedCubics();
	if (completed > 0) {
		console.log(`[cubic-lifecycle] Synced ${completed} completed cubics`);
	}

	// Step 4: Cleanup stale cubics
	const report = await cleanup.cleanupStaleCubics({ removeWorktrees, dryRun });
	if (report.expired > 0 || report.errors.length > 0) {
		console.log(
			`[cubic-lifecycle] Cleanup: ${report.total_stale} stale, ` +
				`${report.expired} expired, ${report.worktrees_removed} worktrees removed`,
		);
	}

	// Step 5: Expire very old cubics (predate cubic_state, 60+ min)
	if (!dryRun) {
		const oldExpired = await cleanup.expireOldCubics(60);
		if (oldExpired > 0) {
			console.log(`[cubic-lifecycle] Expired ${oldExpired} old cubics (>60 min)`);
		}
	}

	// P404: 15-minute backstop sweep for orphaned scratch directories
	// (reap-stale-rows covers orchestrator boot; this catches crashes between boots)
	try {
		const reaped = await reapOrphanScratch();
		if (reaped > 0) {
			console.log(`[cubic-lifecycle] Reaped ${reaped} orphan scratch dir(s)`);
		}
	} catch (err) {
		console.error(`[cubic-lifecycle] scratch reap failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Report errors
	if (report.errors.length > 0) {
		console.error(`[cubic-lifecycle] Errors:`);
		for (const err of report.errors) {
			console.error(`  - ${err}`);
		}
	}

	// Summary
	const stats = await detector.getStats();
	console.log(`[cubic-lifecycle] Stats:`);
	for (const s of stats) {
		console.log(`  ${s.lifecycle_status}: ${s.count}`);
	}

	console.log("[cubic-lifecycle] Done.");
}

main().catch((err) => {
	console.error("[cubic-lifecycle] Fatal error:", err);
	process.exit(1);
});
