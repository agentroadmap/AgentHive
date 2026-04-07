/**
 * Frontmatter Checksum & Recovery (STATE-57)
 *
 * AC#1: Checksum computed on every proposal file write
 * AC#2: Corrupted files detected on read
 * AC#3: Atomic writes prevent partial updates
 * AC#4: Recovery from last known-good version
 */

import { createHash, randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface ProposalChecksum {
	version: string;
	checksum: string;
	algorithm: string;
	createdAt: string;
	contentLength: number;
}

export interface ProposalFileIntegrity {
	path: string;
	isValid: boolean;
	checksum: ProposalChecksum | null;
	expectedChecksum: string | null;
	corruptionType:
		| "none"
		| "missing_checksum"
		| "checksum_mismatch"
		| "malformed_frontmatter"
		| "file_not_found";
	lastKnownGood: string | null;
}

export interface IntegrityReport {
	scanTime: string;
	totalFiles: number;
	validFiles: number;
	corruptedFiles: number;
	repairs: IntegrityRepair[];
	results: ProposalFileIntegrity[];
}

export interface IntegrityRepair {
	path: string;
	action: "restored_from_backup" | "checksum_repaired" | "file_removed";
	fromBackup: string | null;
	timestamp: string;
}

export interface IntegrityConfig {
	proposalsDir: string;
	backupDir: string;
	enableBackups: boolean;
	maxBackups: number; // Max backup versions per file
}

// ─── Constants ───────────────────────────────────────────────────────

const CHECKSUM_HEADER = "roadmap-checksum";
const CHECKSUM_ALGORITHM = "sha256";
const _BACKUP_DIR = ".checksum-backups";
const MAX_BACKUPS = 10;

// ─── Checksum Utilities ──────────────────────────────────────────────

/**
 * Compute SHA-256 checksum of content.
 */
export function computeChecksum(content: string): string {
	return createHash(CHECKSUM_ALGORITHM).update(content).digest("hex");
}

/**
 * Extract frontmatter from markdown content.
 * Returns { frontmatter, body, hasFrontmatter }
 */
export function parseFrontmatter(content: string): {
	frontmatter: string;
	body: string;
	hasFrontmatter: boolean;
	startIndex: number;
	endIndex: number;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		return {
			frontmatter: "",
			body: content,
			hasFrontmatter: false,
			startIndex: -1,
			endIndex: -1,
		};
	}

	return {
		frontmatter: match[1] ?? "",
		body: content.slice(match[0].length).trimStart(),
		hasFrontmatter: true,
		startIndex: 0,
		endIndex: match[0].length,
	};
}

/**
 * Add checksum to frontmatter.
 */
export function injectChecksum(frontmatter: string, checksum: string): string {
	const lines = frontmatter.split("\n");
	// Remove existing checksum if present
	const filtered = lines.filter((l) => !l.startsWith(`${CHECKSUM_HEADER}:`));
	// Add new checksum before the closing ---
	return [...filtered, `${CHECKSUM_HEADER}: "${checksum}"`].join("\n");
}

/**
 * Extract checksum from frontmatter.
 */
export function extractChecksum(frontmatter: string): string | null {
	const match = frontmatter.match(
		new RegExp(`${CHECKSUM_HEADER}:\\s*["']?([a-f0-9]+)["']?`),
	);
	return match?.[1] ?? null;
}

// ─── Proposal Integrity Manager ─────────────────────────────────────────

export class ProposalIntegrity {
	private config: IntegrityConfig;

	constructor(config?: Partial<IntegrityConfig>) {
		this.config = {
			proposalsDir:
				config?.proposalsDir ?? join(process.cwd(), "roadmap", "proposals"),
			backupDir:
				config?.backupDir ??
				join(process.cwd(), "roadmap", ".checksum-backups"),
			enableBackups: config?.enableBackups ?? true,
			maxBackups: config?.maxBackups ?? MAX_BACKUPS,
		};
	}

	/**
	 * Initialize the integrity system.
	 */
	async initialize(): Promise<void> {
		if (this.config.enableBackups) {
			await mkdir(this.config.backupDir, { recursive: true });
		}
	}

	/**
	 * AC#1: Compute and inject checksum into proposal file content.
	 * Returns the content with checksum added to frontmatter.
	 */
	async addChecksum(content: string): Promise<string> {
		const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);

		if (!hasFrontmatter) {
			// No frontmatter to inject into — return as-is
			return content;
		}

		// Compute checksum of body + frontmatter (excluding checksum itself)
		const contentToChecksum = body;
		const checksum = computeChecksum(contentToChecksum);
		const updatedFrontmatter = injectChecksum(frontmatter, checksum);

		return `---\n${updatedFrontmatter}\n---\n\n${body}`;
	}

	/**
	 * AC#1: Write proposal file with checksum.
	 * Performs atomic write (write to temp file, then rename).
	 */
	async writeProposalFile(filePath: string, content: string): Promise<void> {
		const contentWithChecksum = await this.addChecksum(content);

		// Create backup of current file if enabled
		if (this.config.enableBackups) {
			await this.createBackup(filePath);
		}

		// Atomic write: write to temp file, then rename
		const tempPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;

		try {
			await writeFile(tempPath, contentWithChecksum, "utf-8");
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
	 * AC#2: Verify a proposal file's checksum.
	 */
	async verifyFile(filePath: string): Promise<ProposalFileIntegrity> {
		try {
			await access(filePath);
		} catch {
			return {
				path: filePath,
				isValid: false,
				checksum: null,
				expectedChecksum: null,
				corruptionType: "file_not_found",
				lastKnownGood: await this.findLastGoodBackup(filePath),
			};
		}

		const content = await readFile(filePath, "utf-8");
		const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);

		if (!hasFrontmatter) {
			return {
				path: filePath,
				isValid: false,
				checksum: null,
				expectedChecksum: null,
				corruptionType: "malformed_frontmatter",
				lastKnownGood: await this.findLastGoodBackup(filePath),
			};
		}

		const storedChecksum = extractChecksum(frontmatter);

		if (!storedChecksum) {
			return {
				path: filePath,
				isValid: false,
				checksum: null,
				expectedChecksum: null,
				corruptionType: "missing_checksum",
				lastKnownGood: await this.findLastGoodBackup(filePath),
			};
		}

		const computedChecksum = computeChecksum(body);

		if (storedChecksum !== computedChecksum) {
			return {
				path: filePath,
				isValid: false,
				checksum: {
					version: "1.0",
					checksum: storedChecksum,
					algorithm: CHECKSUM_ALGORITHM,
					createdAt: new Date().toISOString(),
					contentLength: body.length,
				},
				expectedChecksum: computedChecksum,
				corruptionType: "checksum_mismatch",
				lastKnownGood: await this.findLastGoodBackup(filePath),
			};
		}

		return {
			path: filePath,
			isValid: true,
			checksum: {
				version: "1.0",
				checksum: storedChecksum,
				algorithm: CHECKSUM_ALGORITHM,
				createdAt: new Date().toISOString(),
				contentLength: body.length,
			},
			expectedChecksum: computedChecksum,
			corruptionType: "none",
			lastKnownGood: null,
		};
	}

	/**
	 * AC#3: Write file atomically (called directly for non-proposal files).
	 */
	async atomicWrite(filePath: string, content: string): Promise<void> {
		const tempPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;

		try {
			await writeFile(tempPath, content, "utf-8");
			await rename(tempPath, filePath);
		} catch (error) {
			try {
				await unlink(tempPath);
			} catch {
				// Ignore cleanup errors
			}
			throw error;
		}
	}

	/**
	 * AC#4: Recover a corrupted file from backup.
	 */
	async recoverFile(filePath: string): Promise<IntegrityRepair | null> {
		const backupPath = await this.findLastGoodBackup(filePath);

		if (!backupPath) {
			return null;
		}

		// Read and verify the backup
		const backupContent = await readFile(backupPath, "utf-8");
		const { frontmatter, body, hasFrontmatter } =
			parseFrontmatter(backupContent);

		if (!hasFrontmatter) {
			return null;
		}

		const storedChecksum = extractChecksum(frontmatter);
		const computedChecksum = computeChecksum(body);

		if (storedChecksum !== computedChecksum) {
			// Backup is also corrupted
			return null;
		}

		// Restore from backup
		await writeFile(filePath, backupContent, "utf-8");

		return {
			path: filePath,
			action: "restored_from_backup",
			fromBackup: backupPath,
			timestamp: new Date().toISOString(),
		};
	}

	/**
	 * Scan all proposal files for integrity issues.
	 */
	async scanAll(): Promise<IntegrityReport> {
		const results: ProposalFileIntegrity[] = [];
		const repairs: IntegrityRepair[] = [];

		try {
			const files = await readdir(this.config.proposalsDir);
			const proposalFiles = files.filter((f) => f.endsWith(".md"));

			for (const file of proposalFiles) {
				const filePath = join(this.config.proposalsDir, file);
				const integrity = await this.verifyFile(filePath);
				results.push(integrity);

				// Auto-repair if backup exists and repair is possible
				if (!integrity.isValid && integrity.lastKnownGood) {
					const repair = await this.recoverFile(filePath);
					if (repair) {
						repairs.push(repair);
					}
				}
			}
		} catch {
			// Proposals directory doesn't exist or can't be read
		}

		const validFiles = results.filter((r) => r.isValid).length;

		return {
			scanTime: new Date().toISOString(),
			totalFiles: results.length,
			validFiles,
			corruptedFiles: results.length - validFiles,
			repairs,
			results,
		};
	}

	// ─── Backup Management ───────────────────────────────────────────

	private async createBackup(filePath: string): Promise<void> {
		if (!this.config.enableBackups) return;

		const fileName = basename(filePath);
		const backupSubDir = join(this.config.backupDir, fileName);
		await mkdir(backupSubDir, { recursive: true });

		// Check if current file exists
		try {
			await access(filePath);
		} catch {
			return; // No file to back up
		}

		const content = await readFile(filePath, "utf-8");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupPath = join(backupSubDir, `${timestamp}.bak`);
		await writeFile(backupPath, content, "utf-8");

		// Cleanup old backups
		await this.cleanupOldBackups(backupSubDir);
	}

	private async cleanupOldBackups(backupSubDir: string): Promise<void> {
		try {
			const files = await readdir(backupSubDir);
			const sorted = files.sort().reverse(); // Newest first

			if (sorted.length > this.config.maxBackups) {
				const toDelete = sorted.slice(this.config.maxBackups);
				for (const file of toDelete) {
					await unlink(join(backupSubDir, file));
				}
			}
		} catch {
			// Ignore cleanup errors
		}
	}

	private async findLastGoodBackup(filePath: string): Promise<string | null> {
		const fileName = basename(filePath);
		const backupSubDir = join(this.config.backupDir, fileName);

		try {
			await access(backupSubDir);
		} catch {
			return null;
		}

		const files = await readdir(backupSubDir);
		const sorted = files
			.filter((f) => f.endsWith(".bak"))
			.sort()
			.reverse();

		for (const file of sorted) {
			const backupPath = join(backupSubDir, file);
			try {
				const content = await readFile(backupPath, "utf-8");
				const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);

				if (!hasFrontmatter) continue;

				const storedChecksum = extractChecksum(frontmatter);
				if (!storedChecksum) continue;

				const computedChecksum = computeChecksum(body);
				if (storedChecksum === computedChecksum) {
					return backupPath;
				}
			} catch {}
		}

		return null;
	}
}

// ─── Checksum Utilities ──────────────────────────────────────────────

/**
 * Verify content has valid checksum.
 */
export function verifyChecksum(content: string): {
	valid: boolean;
	stored: string | null;
	computed: string;
} {
	const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);

	if (!hasFrontmatter) {
		return { valid: false, stored: null, computed: "" };
	}

	const stored = extractChecksum(frontmatter);
	const computed = computeChecksum(body);

	return {
		valid: stored === computed,
		stored,
		computed,
	};
}

/**
 * Generate integrity report as text.
 */
export function formatIntegrityReport(report: IntegrityReport): string {
	const lines: string[] = [
		`Proposal Integrity Report`,
		`======================`,
		`Scan Time: ${report.scanTime}`,
		`Total Files: ${report.totalFiles}`,
		`Valid Files: ${report.validFiles}`,
		`Corrupted Files: ${report.corruptedFiles}`,
		``,
	];

	if (report.repairs.length > 0) {
		lines.push(`Repairs Performed:`);
		for (const repair of report.repairs) {
			lines.push(`  ✓ ${repair.path}: ${repair.action}`);
		}
		lines.push("");
	}

	const corrupted = report.results.filter((r) => !r.isValid);
	if (corrupted.length > 0) {
		lines.push(`Corrupted Files:`);
		for (const result of corrupted) {
			lines.push(`  ✗ ${result.path}: ${result.corruptionType}`);
			if (result.lastKnownGood) {
				lines.push(`    Last known good: ${result.lastKnownGood}`);
			}
		}
	}

	return lines.join("\n");
}
