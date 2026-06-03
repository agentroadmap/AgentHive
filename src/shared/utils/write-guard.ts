/**
 * P404: WriteGuard — advisory utility that rejects writes to source-controlled
 * directories from within an agent scratch context.
 *
 * Agents working in /tmp/agenthive/<uuid>/ must call assertScratchWrite before
 * writing to any path. Writes to src/, docs/, scripts/, tests/ are rejected
 * unless the caller opts in explicitly (for build tools that know what they're doing).
 */

import { resolve } from "node:path";

const PROTECTED_PREFIXES: string[] = [
	resolve("src"),
	resolve("docs"),
	resolve("scripts"),
	resolve("tests"),
];

export interface WriteGuardOptions {
	/** Bypass the guard for callers that explicitly acknowledge the risk. */
	optIn?: boolean;
}

/**
 * Throw if targetPath falls inside a protected source-controlled directory.
 *
 * @param targetPath - absolute or relative path the caller intends to write
 * @param opts.optIn - set true to bypass (use sparingly)
 */
export function assertScratchWrite(
	targetPath: string,
	opts: WriteGuardOptions = {},
): void {
	if (opts.optIn) return;

	const abs = resolve(targetPath);
	for (const prefix of PROTECTED_PREFIXES) {
		if (abs === prefix || abs.startsWith(prefix + "/")) {
			throw new Error(
				`WriteGuard: write to "${abs}" is blocked — path is inside protected dir "${prefix}". ` +
					`Use { optIn: true } if this write is intentional.`,
			);
		}
	}
}
