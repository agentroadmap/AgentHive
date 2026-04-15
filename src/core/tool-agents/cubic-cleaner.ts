/**
 * Cubic Cleaner — zero-cost idle cubic expiry.
 *
 * Periodically scans for cubics that have been idle beyond the timeout
 * and expires them. Optionally cleans up their worktree directories.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

const WORKTREE_ROOT = "/data/code/worktree";

interface CubicCleanerConfig {
	idleTimeoutMinutes?: number;
	cleanupWorktree?: boolean;
}

interface CubicRow {
	id: string;
	name: string;
	agent: string | null;
	phase: string;
	locked_at: string | null;
	updated_at: string | null;
}

export class CubicCleaner implements ToolAgent {
	identity = "tool/cubic-cleaner";
	capabilities = ["cubic-expiry", "worktree-cleanup", "resource-reclamation"];

	private readonly idleTimeoutMs: number;
	private readonly cleanupWorktree: boolean;

	constructor(config: Record<string, unknown>) {
		const cfg = config as CubicCleanerConfig;
		this.idleTimeoutMs = (cfg.idleTimeoutMinutes ?? 60) * 60_000;
		this.cleanupWorktree = cfg.cleanupWorktree ?? true;
	}

	async invoke(_task: ToolTask): Promise<ToolResult> {
		const cutoff = new Date(Date.now() - this.idleTimeoutMs).toISOString();

		// Find cubics idle beyond threshold
		const { rows: cubics } = await query<CubicRow>(
			`SELECT id, name, agent, phase, locked_at, updated_at
			   FROM roadmap.cubic
			  WHERE phase NOT IN ('complete', 'archived')
			    AND updated_at < $1`,
			[cutoff],
		);

		let cleaned = 0;

		for (const cubic of cubics) {
			// Mark as archived
			await query(
				`UPDATE roadmap.cubic
				    SET phase = 'archived',
				        updated_at = now()
				  WHERE id = $1`,
				[cubic.id],
			);

			// Optionally clean worktree
			if (this.cleanupWorktree && cubic.agent) {
				const worktreePath = join(WORKTREE_ROOT, cubic.agent);
				if (existsSync(worktreePath)) {
					try {
						await rm(worktreePath, {
							recursive: true,
							force: true,
						});
					} catch {
						// Non-fatal — directory may be in use
					}
				}
			}

			cleaned++;
		}

		return {
			success: true,
			output: `Cubic cleaner: ${cubics.length} idle cubics found, ${cleaned} archived`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			await query(`SELECT 1 FROM roadmap.cubic LIMIT 1`);
			return true;
		} catch {
			return false;
		}
	}
}
