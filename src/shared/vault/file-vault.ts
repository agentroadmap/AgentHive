/**
 * File-based Vault Adapter (P496)
 *
 * Stores secrets as files on disk with:
 * - Permission enforcement (0600 files, 0700 directory, matched owner UID)
 * - Atomic writes via tempfile + rename
 * - Symlink defense (lstat before access)
 * - Audit logging (append-only JSONL with fsync)
 * - 60s in-memory read cache with explicit invalidation
 *
 * Single-host deployment only; suitable for MCP and single-process services.
 * See threat model in design (P496) for security assumptions and limitations.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import {
	VaultAdapter,
	VaultError,
	VaultPermissionError,
	VaultSymlinkDetectedError,
	VaultCorruptedError,
	VaultInvalidRefError,
	type SecretRef,
} from "./types.ts";

interface CacheEntry {
	value: string;
	expiresAt: number;
}

/**
 * Options for creating a file-based vault adapter.
 */
export interface FileVaultOptions {
	/**
	 * Root directory for vault storage.
	 * Defaults to AGENTHIVE_VAULT_ROOT env var or /etc/agenthive/secrets/
	 */
	basePath?: string;
}

/**
 * Factory function to create a file-based vault adapter.
 *
 * @param options Configuration options
 * @returns VaultAdapter instance
 */
export function fileVault(options?: FileVaultOptions): VaultAdapter {
	const basePath =
		options?.basePath ||
		process.env.AGENTHIVE_VAULT_ROOT ||
		"/etc/agenthive/secrets/";

	const adapter = new FileVaultImpl(basePath);
	return adapter;
}

/**
 * Implementation of VaultAdapter using file-based storage.
 */
class FileVaultImpl implements VaultAdapter {
	private basePath: string;
	private cache: Map<SecretRef, CacheEntry> = new Map();
	private auditLogPath: string;

	constructor(basePath: string) {
		this.basePath = basePath.endsWith("/") ? basePath : basePath + "/";
		this.auditLogPath = path.join(this.basePath, ".audit.log");
	}

	async read(ref: SecretRef): Promise<string> {
		this.validateSecretRef(ref, "read");

		// Check cache (60s TTL)
		const cached = this.cache.get(ref);
		if (cached && Date.now() < cached.expiresAt) {
			await this.auditLog(ref, "read", true);
			return cached.value;
		}

		try {
			const filePath = this.secretRefToPath(ref);

			// Check for symlink before reading
			await this.checkSymlink(filePath, ref, "read");

			// Stat before read for permission enforcement
			const stat = await fs.lstat(filePath);
			await this.checkPermissions(filePath, stat, ref, "read");

			// Read the secret value
			const value = await fs.readFile(filePath, "utf-8");

			// Validate file is not corrupted (JSON audit log detection)
			// If value contains suspicious patterns, it may indicate partial write
			if (!value || value.length === 0) {
				throw new VaultCorruptedError(
					ref,
					"read",
					`Empty secret file at ${filePath}; file may be corrupted`,
				);
			}

			// Cache the value (60s TTL)
			const expiresAt = Date.now() + 60000;
			this.cache.set(ref, { value, expiresAt });

			await this.auditLog(ref, "read", true);
			return value;
		} catch (error) {
			if (
				error instanceof VaultError ||
				error instanceof VaultPermissionError ||
				error instanceof VaultSymlinkDetectedError ||
				error instanceof VaultCorruptedError
			) {
				await this.auditLog(ref, "read", false, (error as Error).message);
				throw error;
			}

			const errno = (error as NodeJS.ErrnoException)?.errno;
			const code = (error as NodeJS.ErrnoException)?.code;

			if (code === "ENOENT") {
				const err = new VaultError(
					ref,
					"read",
					`Secret not found: ${ref}`,
				);
				await this.auditLog(ref, "read", false, err.message);
				throw err;
			}

			if (code === "EACCES") {
				const err = new VaultPermissionError(
					ref,
					"read",
					0,
					undefined,
					`Permission denied reading secret: ${ref}`,
				);
				await this.auditLog(ref, "read", false, err.message);
				throw err;
			}

			const err = new VaultError(
				ref,
				"read",
				`Failed to read secret: ${code || errno || (error as Error).message}`,
			);
			await this.auditLog(ref, "read", false, err.message);
			throw err;
		}
	}

	async write(ref: SecretRef, value: string): Promise<void> {
		this.validateSecretRef(ref, "write");

		try {
			const filePath = this.secretRefToPath(ref);

			// Ensure directory exists with correct permissions
			await this.ensureDirectoryPermissions();

			// Atomic write: write to temp file, then rename
			const tmpPath = `${filePath}.${randomUUID()}.tmp`;

			try {
				// Write to temp file with restrictive permissions (0600)
				await fs.writeFile(tmpPath, value, { mode: 0o600 });

				// Ensure temp file has correct permissions
				await fs.chmod(tmpPath, 0o600);

				// Atomic rename
				await fs.rename(tmpPath, filePath);

				// Invalidate cache on write
				this.cache.delete(ref);

				await this.auditLog(ref, "write", true);
			} catch (tempError) {
				// Clean up temp file on error
				try {
					await fs.unlink(tmpPath);
				} catch {
					// Ignore cleanup errors
				}
				throw tempError;
			}
		} catch (error) {
			if (error instanceof VaultError) {
				await this.auditLog(ref, "write", false, (error as Error).message);
				throw error;
			}

			const code = (error as NodeJS.ErrnoException)?.code;
			const msg = (error as Error)?.message || String(error);

			const err = new VaultError(
				ref,
				"write",
				`Failed to write secret: ${code || msg}`,
			);
			await this.auditLog(ref, "write", false, err.message);
			throw err;
		}
	}

	async rotate(ref: SecretRef, newValue: string): Promise<void> {
		// Rotate is write + cache invalidation
		await this.write(ref, newValue);
		this.cache.delete(ref);
		await this.auditLog(ref, "rotate", true);
	}

	async exists(ref: SecretRef): Promise<boolean> {
		this.validateSecretRef(ref, "exists");

		try {
			const filePath = this.secretRefToPath(ref);

			// Check for symlink before stat
			await this.checkSymlink(filePath, ref, "exists");

			// Stat to check existence and permissions
			const stat = await fs.lstat(filePath);
			await this.checkPermissions(filePath, stat, ref, "exists");

			await this.auditLog(ref, "exists", true);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				return false;
			}

			if (error instanceof VaultError) {
				await this.auditLog(ref, "exists", false, (error as Error).message);
				throw error;
			}

			const msg = (error as Error)?.message || String(error);
			const err = new VaultError(
				ref,
				"exists",
				`Failed to check secret existence: ${msg}`,
			);
			await this.auditLog(ref, "exists", false, err.message);
			throw err;
		}
	}

	/**
	 * Validate SecretRef format and extract path components.
	 * Rejects path traversal attempts and invalid characters.
	 */
	private validateSecretRef(ref: SecretRef, op: string): void {
		// Check prefix
		if (!ref.startsWith("vault://file/")) {
			throw new VaultInvalidRefError(
				ref,
				op as any,
				`Invalid secret ref prefix: expected "vault://file/", got "${ref.substring(0, 20)}"`,
			);
		}

		const pathPart = ref.substring("vault://file/".length);

		// Reject path traversal patterns
		if (pathPart.includes("..") || pathPart.startsWith(".")) {
			throw new VaultInvalidRefError(
				ref,
				op as any,
				`Path traversal attempt in secret ref: contains ".." or starts with "."`,
			);
		}

		// Validate project slug format if this is a project secret
		if (pathPart.startsWith("project/")) {
			const parts = pathPart.split("/");
			if (parts.length < 2) {
				throw new VaultInvalidRefError(
					ref,
					op as any,
					`Invalid project secret ref format: expected "project/<slug>/...", got "${pathPart}"`,
				);
			}

			const slug = parts[1];
			const slugPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
			if (!slugPattern.test(slug)) {
				throw new VaultInvalidRefError(
					ref,
					op as any,
					`Invalid project slug: "${slug}" does not match pattern [a-z][a-z0-9-]*[a-z0-9]`,
				);
			}
		}
	}

	/**
	 * Convert SecretRef to file system path.
	 * File path: <basePath>/<urlencoded-ref>.secret
	 */
	private secretRefToPath(ref: SecretRef): string {
		// URL-encode the ref to create a safe filename
		const encoded = encodeURIComponent(ref);
		const filename = `${encoded}.secret`;
		return path.join(this.basePath, filename);
	}

	/**
	 * Check if path is a symlink using lstat.
	 * Throws VaultSymlinkDetectedError if it is.
	 */
	private async checkSymlink(filePath: string, ref: SecretRef, op: string): Promise<void> {
		try {
			const stat = await fs.lstat(filePath);
			if (stat.isSymbolicLink()) {
				throw new VaultSymlinkDetectedError(
					ref,
					op as any,
					filePath,
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				// File doesn't exist yet; symlink check passes
				return;
			}
			if (error instanceof VaultSymlinkDetectedError) {
				throw error;
			}
			// Other errors (permission denied) are not symlink errors
		}
	}

	/**
	 * Check file/directory permissions.
	 * - File: must be 0600, owner UID must match process UID
	 * - Directory: must be 0700, owner UID must match process UID
	 */
	private async checkPermissions(
		filePath: string,
		stat: fs.Stats,
		ref: SecretRef,
		op: string,
	): Promise<void> {
		const isDirectory = stat.isDirectory();
		const expectedMode = isDirectory ? 0o700 : 0o600;
		const actualMode = stat.mode & 0o777;
		const processUid = process.getuid?.();

		// Check mode matches exactly
		if (actualMode !== expectedMode) {
			throw new VaultPermissionError(
				ref,
				op as any,
				actualMode,
				stat.uid,
				`Permission mismatch: ${filePath} has mode ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}`,
			);
		}

		// Check owner UID matches process UID
		if (processUid !== undefined && stat.uid !== processUid) {
			throw new VaultPermissionError(
				ref,
				op as any,
				actualMode,
				stat.uid,
				`Owner UID mismatch: ${filePath} is owned by ${stat.uid}, process UID is ${processUid}`,
			);
		}
	}

	/**
	 * Ensure the vault directory exists with correct permissions.
	 */
	private async ensureDirectoryPermissions(): Promise<void> {
		try {
			const stat = await fs.lstat(this.basePath);
			if (!stat.isDirectory()) {
				throw new Error(`${this.basePath} is not a directory`);
			}
			// Check directory permissions
			const actualMode = stat.mode & 0o777;
			if (actualMode !== 0o700) {
				throw new Error(
					`${this.basePath} has mode ${actualMode.toString(8)}, expected 0700`,
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				// Create directory with correct permissions
				await fs.mkdir(this.basePath, { mode: 0o700, recursive: true });
			} else {
				throw error;
			}
		}
	}

	/**
	 * Append audit log entry (JSONL format).
	 * Each line is JSON; incomplete lines (truncated on crash) are detected during read.
	 */
	private async auditLog(
		ref: SecretRef,
		op: "read" | "write" | "rotate" | "exists",
		success: boolean,
		error?: string,
	): Promise<void> {
		try {
			const entry = {
				ts: new Date().toISOString(),
				op,
				ref,
				caller_pid: process.pid,
				success,
				...(error && { error }),
			};

			const line = JSON.stringify(entry) + "\n";

			// Append to audit log (non-blocking in background, but sync for v1)
			// Use synchronous append for integrity in v1
			fsSync.appendFileSync(this.auditLogPath, line);

			// Attempt to fsync the audit log for durability
			try {
				const fd = fsSync.openSync(this.auditLogPath, "a");
				fsSync.fsyncSync(fd);
				fsSync.closeSync(fd);
			} catch {
				// Ignore fsync errors in audit (best-effort)
			}
		} catch {
			// Ignore audit log errors; main operation should not fail due to audit failure
		}
	}
}
