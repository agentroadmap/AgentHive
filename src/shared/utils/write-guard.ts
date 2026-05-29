/**
 * P404: WriteGuard — prevents agents from writing to protected directories.
 *
 * Protected by default: src/, docs/, scripts/, tests/ relative to project root.
 * Agents must write to AGENT_SCRATCH_DIR or an explicitly opted-in path.
 *
 * Usage:
 *   import { assertWriteAllowed } from "./write-guard.ts";
 *   assertWriteAllowed("/tmp/agenthive/abc-123/report.md"); // OK
 *   assertWriteAllowed("/data/code/AgentHive/docs/foo.md"); // throws
 */

import { resolve } from "node:path";

const PROTECTED_DIRS = ["src", "docs", "scripts", "tests"] as const;

export interface WriteGuardOptions {
	/** Project root used to resolve protected dir prefixes. Defaults to CWD. */
	projectRoot?: string;
	/** Additional paths (absolute or relative to projectRoot) that are allowed. */
	allowedPaths?: string[];
}

/**
 * Throws if writing to `targetPath` is not allowed.
 * Pass `{ allowedPaths: ["reports"] }` to permit writing to a known output dir.
 */
export function assertWriteAllowed(
	targetPath: string,
	opts: WriteGuardOptions = {},
): void {
	const root = resolve(opts.projectRoot ?? process.cwd());
	const abs = resolve(targetPath);

	// AGENT_SCRATCH_DIR is always allowed.
	const scratchDir = process.env.AGENT_SCRATCH_DIR;
	if (scratchDir && abs.startsWith(resolve(scratchDir) + "/")) return;
	if (scratchDir && abs === resolve(scratchDir)) return;

	// Explicitly opted-in paths are allowed.
	if (opts.allowedPaths) {
		for (const allowed of opts.allowedPaths) {
			const absAllowed = resolve(root, allowed);
			if (abs.startsWith(absAllowed + "/") || abs === absAllowed) return;
		}
	}

	// Block writes into protected directories.
	for (const dir of PROTECTED_DIRS) {
		const absDir = resolve(root, dir);
		if (abs.startsWith(absDir + "/") || abs === absDir) {
			throw new Error(
				`[WriteGuard] Write to protected path rejected: ${targetPath}\n` +
					`Use AGENT_SCRATCH_DIR for ephemeral agent output.`,
			);
		}
	}
}
