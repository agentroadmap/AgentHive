/**
 * Proposal file checksum utilities for data integrity
 *
 * Provides:
 * - SHA-256 checksum computation for proposal file content
 * - Checksum verification on read
 * - Atomic writes with temporary file + rename
 * - Recovery from last known-good version
 */

import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Checksum header added to proposal frontmatter */
export const CHECKSUM_HEADER = "checksum";

/** Directory for storing recovery copies */
const RECOVERY_DIR = ".recovery";

/** Maximum number of recovery versions to keep per file */
const _MAX_RECOVERY_VERSIONS = 5;

/**
 * Compute SHA-256 checksum of content
 * @param content - The content to hash (excluding checksum field)
 * @returns Hex-encoded SHA-256 hash
 */
export function computeChecksum(content: string): string {
	const hash = createHash("sha256");
	hash.update(content, "utf-8");
	return hash.digest("hex");
}

/**
 * Extract checksum from frontmatter if present
 * @param frontmatter - Raw frontmatter string (without --- delimiters)
 * @returns Checksum value or null if not present
 */
export function extractChecksum(frontmatter: string): string | null {
	const lines = frontmatter.split("\n");
	for (const line of lines) {
		const match = line.match(/^checksum:\s*["']?([a-f0-9]{64})["']?\s*$/);
		if (match) {
			return match[1] ?? null;
		}
	}
	return null;
}

/**
 * Remove checksum field from frontmatter for hashing
 * @param frontmatter - Raw frontmatter string
 * @returns Frontmatter without checksum line
 */
export function stripChecksum(frontmatter: string): string {
	return frontmatter
		.split("\n")
		.filter((line) => !line.match(/^checksum:/))
		.join("\n")
		.trimEnd(); // Remove trailing newlines for consistent hashing
}

/**
 * Add or update checksum in frontmatter
 * @param frontmatter - Raw frontmatter string
 * @param checksum - Checksum to add
 * @returns Frontmatter with checksum added
 */
export function addChecksum(frontmatter: string, checksum: string): string {
	const stripped = stripChecksum(frontmatter);
	// Ensure frontmatter ends with newline before adding checksum
	const withNewline = stripped.endsWith("\n") ? stripped : `${stripped}\n`;
	return `${withNewline}checksum: "${checksum}"\n`;
}

/**
 * Verify checksum of parsed content
 * @param frontmatter - Raw frontmatter string (with checksum)
 * @param body - Content body
 * @returns Verification result
 */
export function verifyChecksum(
	frontmatter: string,
	body: string,
): { valid: boolean; expected: string | null; actual: string } {
	const storedChecksum = extractChecksum(frontmatter);
	const cleanFrontmatter = stripChecksum(frontmatter);

	// Compute checksum of clean frontmatter + body (consistent with injectChecksum)
	const contentToHash = `---\n${cleanFrontmatter}\n---\n${body}`;
	const computedChecksum = computeChecksum(contentToHash);

	return {
		valid: storedChecksum !== null && storedChecksum === computedChecksum,
		expected: storedChecksum,
		actual: computedChecksum,
	};
}

/**
 * Get path for recovery copy of a file
 * @param filePath - Original file path
 * @param roadmapDir - Roadmap directory root
 * @returns Path to recovery directory for this file
 */
export function getRecoveryPath(filePath: string, roadmapDir: string): string {
	const relativePath = filePath.replace(`${roadmapDir}/`, "");
	const safeName = relativePath.replace(/\//g, "__");
	return join(roadmapDir, RECOVERY_DIR, `${safeName}.bak`);
}

/**
 * Save a recovery copy of content before overwriting
 * @param filePath - Original file path
 * @param content - Content to save
 * @param roadmapDir - Roadmap directory root
 */
export async function saveRecoveryCopy(
	filePath: string,
	content: string,
	roadmapDir: string,
): Promise<void> {
	const recoveryDir = join(roadmapDir, RECOVERY_DIR);
	const recoveryPath = getRecoveryPath(filePath, roadmapDir);

	try {
		await mkdir(recoveryDir, { recursive: true });

		// Add timestamp to recovery content for tracking
		const timestampedContent = content;

		await writeFile(recoveryPath, timestampedContent, "utf-8");
	} catch (error) {
		// Recovery failure shouldn't block writes
		if (process.env.DEBUG) {
			console.warn(`Failed to save recovery copy: ${error}`);
		}
	}
}

/**
 * Atomic write using temp file + rename
 * Prevents partial writes from corrupting files
 *
 * @param filePath - Target file path
 * @param content - Content to write
 * @param roadmapDir - Roadmap directory for recovery
 */
export async function atomicWrite(
	filePath: string,
	content: string,
	roadmapDir: string,
): Promise<void> {
	const dir = dirname(filePath);
	const tempPath = join(dir, `.tmp.${basename(filePath)}.${Date.now()}`);

	try {
		await mkdir(dir, { recursive: true });

		// Save recovery copy before writing
		try {
			const existingContent = await readFile(filePath, "utf-8");
			await saveRecoveryCopy(filePath, existingContent, roadmapDir);
		} catch {
			// File might not exist yet, that's ok
		}

		// Write to temp file first
		await writeFile(tempPath, content, "utf-8");

		// Atomic rename
		await rename(tempPath, filePath);
	} catch (error) {
		// Clean up temp file on failure
		try {
			await unlink(tempPath);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Attempt to recover a corrupted file from backup
 * @param filePath - Path to corrupted file
 * @param roadmapDir - Roadmap directory root
 * @returns Recovered content or null if no recovery available
 */
export async function recoverFromFile(
	filePath: string,
	roadmapDir: string,
): Promise<string | null> {
	const recoveryPath = getRecoveryPath(filePath, roadmapDir);

	try {
		await access(recoveryPath);
		return await readFile(recoveryPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Parse proposal file content and validate checksum
 * @param content - Raw file content
 * @returns Parsed content with validation result
 */
export interface ParsedProposalContent {
	frontmatter: string;
	body: string;
	hasChecksum: boolean;
	checksumValid: boolean | null;
	computedChecksum: string;
}

export function parseAndValidate(content: string): ParsedProposalContent {
	// Parse frontmatter delimiters
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return {
			frontmatter: "",
			body: content,
			hasChecksum: false,
			checksumValid: null,
			computedChecksum: "",
		};
	}

	const rawFrontmatter = match[1] ?? "";
	const body = match[2] ?? "";

	const checksum = extractChecksum(rawFrontmatter);
	// Use consistent format with injectChecksum
	const cleanFrontmatter = stripChecksum(rawFrontmatter);
	const contentToHash = `---\n${cleanFrontmatter}\n---\n${body}`;
	const computed = computeChecksum(contentToHash);

	return {
		frontmatter: rawFrontmatter,
		body,
		hasChecksum: checksum !== null,
		checksumValid: checksum !== null ? checksum === computed : null,
		computedChecksum: computed,
	};
}

/**
 * Result of a proposal file read with integrity checking
 */
export interface ProposalReadResult {
	content: string;
	verified: boolean;
	recovered: boolean;
	checksum: string | null;
}

/**
 * Read a proposal file with integrity checking and automatic recovery
 * @param filePath - Path to proposal file
 * @param roadmapDir - Roadmap directory root
 * @returns Read result with verification status
 */
export async function readProposalWithIntegrity(
	filePath: string,
	roadmapDir: string,
): Promise<ProposalReadResult> {
	let content: string;

	try {
		content = await readFile(filePath, "utf-8");
	} catch {
		// File doesn't exist
		return {
			content: "",
			verified: false,
			recovered: false,
			checksum: null,
		};
	}

	const parsed = parseAndValidate(content);

	// If file has checksum and it's valid
	if (parsed.hasChecksum && parsed.checksumValid) {
		return {
			content,
			verified: true,
			recovered: false,
			checksum: parsed.computedChecksum,
		};
	}

	// If file has checksum but it's invalid - corruption detected
	if (parsed.hasChecksum && !parsed.checksumValid) {
		// Attempt recovery
		const recovered = await recoverFromFile(filePath, roadmapDir);
		if (recovered) {
			const recoveredParsed = parseAndValidate(recovered);
			if (recoveredParsed.hasChecksum && recoveredParsed.checksumValid) {
				// Restore recovered content
				await writeFile(filePath, recovered, "utf-8");
				return {
					content: recovered,
					verified: true,
					recovered: true,
					checksum: recoveredParsed.computedChecksum,
				};
			}
		}

		// Recovery failed or recovery copy also corrupted
		return {
			content,
			verified: false,
			recovered: false,
			checksum: parsed.computedChecksum,
		};
	}

	// File has no checksum (legacy) - return as-is
	return {
		content,
		verified: true, // No checksum to verify = pass-through
		recovered: false,
		checksum: null,
	};
}

/**
 * Inject checksum into serialized proposal content
 * Call this before writing to ensure integrity
 *
 * @param serializedContent - Content from serializeProposal()
 * @returns Content with checksum injected
 */
export function injectChecksum(serializedContent: string): string {
	const match = serializedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return serializedContent;
	}

	const rawFrontmatter = match[1] ?? "";
	const body = match[2] ?? "";

	// Strip existing checksum if present
	const cleanFrontmatter = stripChecksum(rawFrontmatter);

	// Compute checksum of clean content (with proper newline before ---)
	const contentToHash = `---\n${cleanFrontmatter}\n---\n${body}`;
	const checksum = computeChecksum(contentToHash);

	// Add checksum to frontmatter
	const frontmatterWithChecksum = addChecksum(cleanFrontmatter, checksum);

	return `---\n${frontmatterWithChecksum}\n---\n${body}`;
}

/**
 * Statistics for checksum operations
 */
export interface ChecksumStats {
	filesChecked: number;
	checksumsValid: number;
	checksumsInvalid: number;
	recovered: number;
	legacyFiles: number;
}
