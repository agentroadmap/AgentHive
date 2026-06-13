/**
 * P1392: Tier-1 file-based persona resolver.
 *
 * Resolves agent personas from ~/.claude/agents/*.md files, with caching and
 * configurable TTL (for testing via AGENTHIVE_PERSONA_DIR override).
 *
 * Precedence order (implemented in resolvePersona() and integrated at caller):
 *   1. payload.persona (orchestrator pre-resolved) — highest priority.
 *   2. File-based Tier-1 (this module) — Tier-1 agent definitions.
 *   3. DB lookup (resolvePersonaByRoleName) — gate_role + agent_role_profile tables.
 *   4. Generic fallback — lowest priority.
 *
 * Role matching strategy:
 *   - Input role 'software-architect' matches file 'engineering-software-architect.md'
 *     by suffix (category-prefix match drops the prefix).
 *   - Case-insensitive: 'Software Architect' → normalized to 'software-architect'.
 *   - File mtime is tracked; stale cache entries invalidated on file change (or on TTL).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolved persona with metadata.
 */
export interface ResolvedPersona {
	source: "file" | "db" | "fallback";
	body: string;
	personaName?: string; // For telemetry: the resolved persona name/path
}

/**
 * Cache entry with TTL and file mtime tracking.
 */
interface CacheEntry {
	body: string;
	mtime: number;
	expiresAt: number;
	fileName: string;
}

/**
 * FilePersonaResolver: Manages file-based persona caching with TTL and mtime invalidation.
 */
class FilePersonaResolver {
	private cache = new Map<string, CacheEntry>();
	private personaDir: string;
	private cacheTtlMs: number;

	constructor(
		personaDir?: string,
		cacheTtlMs?: number,
	) {
		// Allow override for testing; default to ~/.claude/agents
		this.personaDir = personaDir ?? join(homedir(), ".claude", "agents");
		// Default 5min TTL; tests can pass shorter
		this.cacheTtlMs = cacheTtlMs ?? 5 * 60 * 1000;
	}

	/**
	 * Normalize role name: lowercase, replace spaces/underscores with hyphens.
	 */
	private normalizeRole(role: string): string {
		return role.toLowerCase().replace(/[\s_]+/g, "-");
	}

	/**
	 * List available persona files and extract role names (category-suffix mapping).
	 * E.g., 'engineering-software-architect.md' matches:
	 *   - 'software-architect' (suffix after first hyphen)
	 *   - 'engineering-software-architect' (full base name)
	 */
	private async listAvailableFiles(): Promise<Map<string, string>> {
		// Map from normalized role → file name (for lookup)
		const roleMap = new Map<string, string>();
		try {
			const { readdir } = await import("node:fs/promises");
			const files = await readdir(this.personaDir, { withFileTypes: true });
			for (const file of files) {
				if (!file.isFile() || !file.name.endsWith(".md")) continue;

				// Extract base name without .md
				const baseName = file.name.slice(0, -3);

				// Add full base name as exact-match key (e.g., 'engineering-software-architect')
				roleMap.set(baseName, baseName);

				// Also add suffix after category prefix (everything after first hyphen)
				// e.g., 'engineering-software-architect' → 'software-architect'
				const parts = baseName.split("-");
				if (parts.length > 1) {
					const suffix = parts.slice(1).join("-"); // everything after first part
					roleMap.set(suffix, baseName);
				}
			}
		} catch (err) {
			console.warn(`[FilePersonaResolver] Failed to list ${this.personaDir}:`, err);
		}
		return roleMap;
	}

	/**
	 * Read a file-based persona; check cache and mtime; validate TTL.
	 *
	 * @param role — normalized role name (e.g., 'software-architect')
	 * @returns persona body, or null if not found or cache miss.
	 */
	async resolve(role: string): Promise<ResolvedPersona | null> {
		const normalizedRole = this.normalizeRole(role);

		// 1. Check cache: if hit and valid, return immediately.
		const cached = this.cache.get(normalizedRole);
		if (cached && cached.expiresAt > Date.now()) {
			try {
				// Validate file hasn't changed on disk
				const currentStat = await stat(join(this.personaDir, cached.fileName));
				if (currentStat.mtimeMs === cached.mtime) {
					return {
						source: "file",
						body: cached.body,
						personaName: cached.fileName,
					};
				}
				// mtime changed — invalidate and fall through to reload
				this.cache.delete(normalizedRole);
			} catch {
				// File gone — invalidate cache
				this.cache.delete(normalizedRole);
			}
		}

		// 2. List available files and find role match.
		const roleMap = await this.listAvailableFiles();
		const fileName = roleMap.get(normalizedRole);
		if (!fileName) {
			return null; // Role not found
		}

		// 3. Read file.
		try {
			const filePath = join(this.personaDir, fileName + ".md");
			const body = await readFile(filePath, "utf-8");
			const fileStat = await stat(filePath);

			// 4. Cache with TTL and mtime.
			this.cache.set(normalizedRole, {
				body,
				mtime: fileStat.mtimeMs,
				expiresAt: Date.now() + this.cacheTtlMs,
				fileName,
			});

			return {
				source: "file",
				body,
				personaName: fileName,
			};
		} catch (err) {
			console.warn(
				`[FilePersonaResolver] Failed to read ${fileName}.md:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	}

	/**
	 * Clear all cached entries (useful for testing).
	 */
	clearCache(): void {
		this.cache.clear();
	}
}

// Global singleton instance
let globalResolver: FilePersonaResolver | null = null;

/**
 * Get or create the global FilePersonaResolver instance.
 * Uses AGENTHIVE_PERSONA_DIR env var for directory (default ~/.claude/agents),
 * and AGENTHIVE_PERSONA_CACHE_TTL_MS for TTL (default 5 min).
 */
export function getFilePersonaResolver(): FilePersonaResolver {
	if (!globalResolver) {
		const personaDir = process.env.AGENTHIVE_PERSONA_DIR;
		const cacheTtl = process.env.AGENTHIVE_PERSONA_CACHE_TTL_MS
			? Number(process.env.AGENTHIVE_PERSONA_CACHE_TTL_MS)
			: undefined;
		globalResolver = new FilePersonaResolver(personaDir, cacheTtl);
	}
	return globalResolver;
}

/**
 * Resolve a persona from file (Tier-1), with fallback to null.
 * Exported for testing.
 */
export async function resolveFilePersona(role: string): Promise<ResolvedPersona | null> {
	const resolver = getFilePersonaResolver();
	return resolver.resolve(role);
}

/**
 * Clear the global resolver cache (testing).
 */
export function clearFilePersonaCache(): void {
	if (globalResolver) {
		globalResolver.clearCache();
	}
}

/**
 * For testing: create a temporary resolver with a custom directory.
 */
export function createTestResolver(
	personaDir: string,
	cacheTtlMs?: number,
): FilePersonaResolver {
	return new FilePersonaResolver(personaDir, cacheTtlMs);
}
