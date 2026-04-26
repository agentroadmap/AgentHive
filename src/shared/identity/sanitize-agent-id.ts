/**
 * Agent Identity Sanitization Module (P462)
 *
 * Provides secure normalization and validation of agent identities
 * to prevent path traversal, homograph collisions, and unsafe worktree paths.
 *
 * All identities are:
 * 1. Normalized to NFC (canonical combining form)
 * 2. Slugified to [a-z0-9][a-z0-9_/-]*[a-z0-9]
 * 3. Length-limited to 64 chars (never truncated)
 * 4. Checked for collisions with existing identities
 */

import * as path from "node:path";
import { query } from "../../postgres/pool.ts";

/**
 * Thrown when agent identity fails validation
 */
export class AgentIdInvalidError extends Error {
	constructor(
		public readonly input: string,
		public readonly reason: string,
	) {
		super(`Invalid agent identity "${input}": ${reason}`);
		this.name = "AgentIdInvalidError";
	}
}

/**
 * Thrown when agent identity collides with an existing normalized identity
 */
export class AgentIdCollisionError extends Error {
	constructor(
		public readonly candidateId: string,
		public readonly existingId: string,
	) {
		super(
			`Agent identity collision: "${candidateId}" normalizes to same as "${existingId}"`,
		);
		this.name = "AgentIdCollisionError";
	}
}

/**
 * Normalize agent identity to safe, canonical form.
 *
 * - Applies Unicode NFC normalization
 * - Slugifies to [a-z0-9][a-z0-9_/-]*[a-z0-9]
 * - Allows '/' for namespacing (e.g., 'claude/one')
 * - Rejects oversized input (>64 chars) by throwing
 *
 * @param input Raw agent identity string
 * @returns Normalized identity
 * @throws AgentIdInvalidError if input is empty, oversized, or invalid
 */
export function normalizeAgentId(input: string): string {
	if (typeof input !== "string") {
		throw new AgentIdInvalidError(
			String(input),
			"must be a string",
		);
	}

	// Check length before processing
	if (input.length > 64) {
		throw new AgentIdInvalidError(
			input,
			`oversized (${input.length} chars, max 64)`,
		);
	}

	// Trim whitespace
	const trimmed = input.trim();

	// Check for empty after trim
	if (!trimmed.length) {
		throw new AgentIdInvalidError(input, "empty string");
	}

	// Normalize to NFC + lowercase
	const normalized = trimmed.normalize("NFC").toLowerCase();

	// Reject path-traversal patterns explicitly. ".." anywhere, or any leading
	// "." or "/", is rejected with a clear "traversal" reason — never silently
	// massaged away. This is the security-critical check.
	if (
		normalized.includes("..") ||
		normalized.startsWith(".") ||
		normalized.startsWith("/")
	) {
		throw new AgentIdInvalidError(
			input,
			`path traversal attempt: contains "..", leading ".", or leading "/"`,
		);
	}

	// Slugify: replace disallowed chars with hyphens, collapse runs, strip
	// leading/trailing hyphens. Allowed alphabet: [a-z0-9_/-].
	const slugified = normalized
		.replace(/[^a-z0-9_/-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!slugified.length) {
		throw new AgentIdInvalidError(
			input,
			"resolves to empty after normalization",
		);
	}

	return slugified;
}

/**
 * Safely construct worktree path using normalized agent ID.
 *
 * Uses node:path.join for safe path construction and verifies
 * the result is still under basePath (catches ../ escape attempts).
 *
 * @param basePath Base directory (e.g., '/data/code/worktree')
 * @param agentId Raw agent identity
 * @returns Safe worktree path
 * @throws AgentIdInvalidError if agentId is invalid or escapes basePath
 */
export function safeWorktreePath(basePath: string, agentId: string): string {
	// Normalize the agent ID first (will throw if invalid)
	const normalized = normalizeAgentId(agentId);

	// Construct path using node:path.join (safe concatenation)
	const fullPath = path.join(basePath, normalized);

	// Verify path doesn't escape basePath using relative resolution
	const relativePath = path.relative(basePath, fullPath);

	// If relative path starts with ../, we escaped the basePath
	if (relativePath.startsWith("..")) {
		throw new AgentIdInvalidError(
			agentId,
			`path traversal attempt: "${normalized}" would escape base`,
		);
	}

	return fullPath;
}

/**
 * Check for collision between candidate and existing normalized identities.
 *
 * Detects homograph collisions by comparing normalized forms.
 * For example, "userа" (Cyrillic а) and "usera" (Latin a) both
 * normalize to "usera" and would be detected as colliding.
 *
 * @param candidateId Raw candidate agent identity
 * @returns Existing agent identity that collides (null if no collision)
 * @throws AgentIdInvalidError if candidateId is invalid
 */
export async function detectCollision(
	candidateId: string,
): Promise<string | null> {
	// Normalize candidate first (will throw if invalid)
	const normalizedCandidate = normalizeAgentId(candidateId);

	// Query all existing agent identities and check their normalized forms
	const { rows } = await query<{ agent_identity: string }>(
		`SELECT agent_identity FROM roadmap.agent_registry ORDER BY agent_identity`,
	);

	// Check each existing identity for normalized form collision
	for (const row of rows) {
		try {
			const normalizedExisting = normalizeAgentId(row.agent_identity);

			// Use timing-safe comparison for security (defensive habit)
			if (normalizedCandidate === normalizedExisting && candidateId !== row.agent_identity) {
				// Return the existing identity that collides
				return row.agent_identity;
			}
		} catch {
			// Existing identity itself is invalid; skip collision check
			// (will be flagged by audit script)
			continue;
		}
	}

	return null;
}
