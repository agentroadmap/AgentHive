/**
 * P404: Agent Scratch Space — provision, reap, and orphan sweep.
 *
 * Each agent run receives an isolated /tmp/agenthive/<uuid>/ directory.
 * The orchestrator creates it before spawn and fires a best-effort reap
 * in the finally block. The 15-minute cron sweep (cubic-lifecycle-cron.ts)
 * is the backstop for SIGKILL/crash cases.
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { query } from "../../infra/postgres/pool.ts";

const execFileAsync = promisify(execFile);

export const SCRATCH_ROOT = "/tmp/agenthive";

// Validates that a path component is a well-formed UUID (no traversal possible).
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function getConfigValue(key: string, defaultVal: string): Promise<string> {
	const { rows } = await query(
		`SELECT value FROM roadmap.config WHERE key = $1`,
		[key],
	);
	return (rows[0]?.value as string | undefined) ?? defaultVal;
}

async function getDirSizeMb(dir: string): Promise<number> {
	const { stdout } = await execFileAsync("du", ["-sb", dir]);
	const bytes = parseInt(stdout.split("\t")[0], 10);
	return isNaN(bytes) ? 0 : bytes / (1024 * 1024);
}

export interface ScratchHandle {
	scratchUuid: string;
	scratchPath: string;
}

export interface ReapOptions {
	dryRun?: boolean;
}

/**
 * Create a scratch directory and register it in agent_scratch_dir.
 * Caller passes the agentRunId obtained after the agent_runs INSERT.
 */
export async function provisionScratch(
	scratchUuid: string,
	agentRunId: string,
	agentIdentity: string,
): Promise<ScratchHandle> {
	const scratchPath = join(SCRATCH_ROOT, scratchUuid);
	await mkdir(scratchPath, { recursive: true, mode: 0o700 });
	await query(
		`INSERT INTO roadmap_workforce.agent_scratch_dir
       (run_id, agent_run_id, agent_identity, expires_at)
     VALUES ($1, $2, $3, now() + interval '4 hours')`,
		[scratchUuid, agentRunId, agentIdentity],
	);
	return { scratchUuid, scratchPath };
}

/**
 * Delete a scratch directory and mark it reaped.
 * Safe to call on already-missing dirs (force:true handles reboot/prior reap).
 */
export async function reapScratch(
	scratchUuid: string,
	opts: ReapOptions = {},
): Promise<void> {
	if (!UUID_RE.test(scratchUuid))
		throw new Error(`Invalid scratch UUID: ${scratchUuid}`);

	const dir = join(SCRATCH_ROOT, scratchUuid);
	const sizeMb = await getDirSizeMb(dir).catch(() => 0);
	const maxSizeMb = Number(
		await getConfigValue("scratch.max_size_mb", "1024").catch(() => "1024"),
	);

	if (opts.dryRun) {
		console.log(`[Reaper/dry-run] would delete ${dir} (${sizeMb.toFixed(1)}MB)`);
		await query(
			`UPDATE roadmap_workforce.agent_scratch_dir
         SET reap_error = $2
       WHERE run_id = $1 AND reaped_at IS NULL`,
			[scratchUuid, `dry-run:${sizeMb.toFixed(1)}MB`],
		);
		return;
	}

	if (sizeMb > maxSizeMb)
		console.warn(
			`[Reaper] WARN scratch ${scratchUuid} is ${sizeMb.toFixed(1)}MB > limit ${maxSizeMb}MB`,
		);

	// force:true is a no-op if the dir is already gone (reboot cleared /tmp).
	await rm(dir, { recursive: true, force: true });
	await query(
		`UPDATE roadmap_workforce.agent_scratch_dir
       SET reaped_at = now(), reap_error = $2, size_mb_at_reap = $3
     WHERE run_id = $1`,
		[
			scratchUuid,
			sizeMb > maxSizeMb ? `size_exceeded:${sizeMb.toFixed(1)}MB` : null,
			sizeMb,
		],
	);
}

/**
 * Sweep all expired, unreaped scratch directories.
 * Called by cubic-lifecycle-cron.ts (15-minute cadence) and on MCP/orchestrator boot.
 * Returns the number of directories reaped.
 */
export async function reapOrphanScratch(opts: ReapOptions = {}): Promise<number> {
	const { rows } = await query(
		`SELECT * FROM roadmap_workforce.fn_reap_orphan_scratch()`,
	);
	let count = 0;
	for (const row of rows) {
		await reapScratch(row.run_id as string, opts).catch((err: unknown) =>
			console.error(
				`[scratch-reaper] failed to reap ${row.run_id}: ${err instanceof Error ? err.message : err}`,
			),
		);
		count++;
	}
	return count;
}
