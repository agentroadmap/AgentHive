/**
 * P404: Agent scratch space lifecycle — provision, reap, and orphan recovery.
 *
 * Every agent run gets an isolated /tmp/agenthive/<uuid>/ directory (mode 0700).
 * Directories are registered in roadmap_workforce.agent_scratch_dir and reaped
 * at process exit (via reapScratch) or via pg_notify (fn_reap_orphan_scratch).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/postgres/pool.ts";

export const SCRATCH_ROOT = "/tmp/agenthive";

// Strict UUID v4 regex — validated before any filesystem path construction.
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProvisionResult {
	scratchUuid: string;
	scratchPath: string;
}

export interface ReapOptions {
	dryRun?: boolean;
}

async function getConfigValue(key: string, fallback: string): Promise<string> {
	try {
		const r = await query<{ value: string }>(
			"SELECT value FROM roadmap.config WHERE key = $1",
			[key],
		);
		return r.rows[0]?.value ?? fallback;
	} catch {
		return fallback;
	}
}

async function getDirSizeMb(dirPath: string): Promise<number | null> {
	try {
		// Use fs.stat for simple size estimate (directory entry only, not recursive)
		// Accurate enough for the size_mb_at_reap audit column.
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		const { stdout } = await exec("du", ["-sm", dirPath]);
		const mb = parseFloat(stdout.split("\t")[0]);
		return isNaN(mb) ? null : mb;
	} catch {
		return null;
	}
}

/**
 * Provision a scratch directory for the current agent run.
 *
 * - Creates /tmp/agenthive/<uuid>/ with mode 0700
 * - Inserts into roadmap_workforce.agent_scratch_dir
 * - Optionally updates roadmap.cubics.scratch_path when cubicId is provided
 */
export async function provisionScratch(opts: {
	agentRunId: string | null;
	agentIdentity: string;
	cubicId?: string | null;
}): Promise<ProvisionResult> {
	const scratchUuid = randomUUID();
	const scratchPath = `${SCRATCH_ROOT}/${scratchUuid}`;

	await mkdir(scratchPath, { recursive: true, mode: 0o700 });

	const maxAgeHours = await getConfigValue("scratch.max_age_hours", "4");
	const agentRunIdNum = opts.agentRunId ? Number(opts.agentRunId) : null;

	await query(
		`INSERT INTO roadmap_workforce.agent_scratch_dir
		   (run_id, agent_run_id, agent_identity, expires_at)
		 VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)`,
		[scratchUuid, agentRunIdNum, opts.agentIdentity, maxAgeHours],
	);

	if (opts.cubicId) {
		await query(
			`UPDATE roadmap.cubics SET scratch_path = $1 WHERE cubic_id = $2`,
			[scratchPath, opts.cubicId],
		).catch(() => {
			/* non-fatal — cubicId may not match any row */
		});
	}

	return { scratchUuid, scratchPath };
}

/**
 * Reap a single scratch directory by its UUID.
 *
 * - UUID_RE validated before any path construction (path traversal prevention)
 * - Measures dir size before removal
 * - Marks reaped_at in DB; records reap_error on failure
 * - dryRun=true skips filesystem removal and DB update (for audit scans)
 */
export async function reapScratch(
	scratchUuid: string,
	opts: ReapOptions = {},
): Promise<void> {
	if (!UUID_RE.test(scratchUuid)) {
		throw new Error(
			`reapScratch: invalid UUID "${scratchUuid}" — path traversal rejected`,
		);
	}

	const scratchPath = `${SCRATCH_ROOT}/${scratchUuid}`;

	if (opts.dryRun) {
		return;
	}

	const sizeMb = existsSync(scratchPath)
		? await getDirSizeMb(scratchPath) ?? 0
		: 0;

	let reapError: string | null = null;
	try {
		if (existsSync(scratchPath)) {
			await rm(scratchPath, { recursive: true, force: true });
		}
	} catch (err) {
		reapError = err instanceof Error ? err.message : String(err);
	}

	await query(
		`UPDATE roadmap_workforce.agent_scratch_dir
		 SET reaped_at = now(),
		     reap_error = $1,
		     size_mb_at_reap = $2
		 WHERE run_id = $3`,
		[reapError, sizeMb, scratchUuid],
	).catch(() => {
		/* non-fatal — DB may already be gone at process exit */
	});
}

/**
 * Get the scratch directory path for the current process.
 * Reads AGENT_SCRATCH_DIR env var (set by agent-spawner.ts).
 */
export function getScratchDir(): string {
	const dir = process.env.AGENT_SCRATCH_DIR;
	if (!dir) {
		throw new Error(
			"AGENT_SCRATCH_DIR is not set — was this process spawned without provisionScratch?",
		);
	}
	return dir;
}

/**
 * Boot-time orphan scan: query DB for all expired+unreaped rows and reap them.
 * Called from reap-stale-rows.ts at orchestrator/MCP startup.
 *
 * @returns count of directories reaped (or found when dryRun=true)
 */
export async function reapOrphanScratch(opts: ReapOptions = {}): Promise<number> {
	const r = await query<{ run_id: string }>(
		`SELECT run_id
		 FROM roadmap_workforce.agent_scratch_dir
		 WHERE reaped_at IS NULL
		   AND expires_at < now()
		   AND (forensic_hold_until IS NULL OR forensic_hold_until < now())`,
	);

	let count = 0;
	for (const row of r.rows) {
		try {
			await reapScratch(row.run_id, opts);
			count++;
		} catch {
			// Invalid UUID rows are skipped; errors logged elsewhere
		}
	}
	return count;
}
