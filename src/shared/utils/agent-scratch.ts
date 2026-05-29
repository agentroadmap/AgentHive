/**
 * P404: Agent scratch-space client utility.
 *
 * Agents read AGENT_SCRATCH_DIR from their environment (set by the orchestrator
 * before spawn) and use this module to obtain typed paths — never construct
 * /tmp/agenthive/<uuid> manually.
 *
 * Falls back to the OS temp dir if AGENT_SCRATCH_DIR is absent (unit tests,
 * local dev runs outside the orchestrator).
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

export const AGENT_SCRATCH_ENV = "AGENT_SCRATCH_DIR";

/**
 * Return the scratch directory path without creating it.
 * Safe to call synchronously anywhere.
 */
export function getScratchDir(): string {
	return process.env[AGENT_SCRATCH_ENV] ?? join(tmpdir(), "agenthive-fallback");
}

/**
 * Ensure the scratch directory exists (mkdir -p) and return its path.
 * Call once at agent startup before writing any files.
 */
export async function ensureScratchDir(): Promise<string> {
	const dir = getScratchDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * Join path components under the scratch directory.
 * Does NOT create the resulting path — call mkdir if needed.
 */
export function scratchPath(...parts: string[]): string {
	return join(getScratchDir(), ...parts);
}
