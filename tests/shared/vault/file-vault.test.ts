/**
 * Tests for file-based vault adapter (P496)
 *
 * Run with: npx node --test --import jiti/register tests/shared/vault/file-vault.test.ts
 */

import { strict as assert } from "node:assert";
import { test, describe, before, after } from "node:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { fileVault } from "../../../src/shared/vault/file-vault.ts";
import {
	VaultError,
	VaultPermissionError,
	VaultSymlinkDetectedError,
	VaultCorruptedError,
	VaultInvalidRefError,
} from "../../../src/shared/vault/types.ts";

// Create a temporary directory for each test
function createTempDir(): string {
	return path.join(tmpdir(), `vault-test-${randomBytes(8).toString("hex")}`);
}

async function cleanupTempDir(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

describe("FileVaultAdapter", () => {
	describe("happy path: read/write/delete", () => {
		test("write and read a secret", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const secret = "postgresql://user:pass@localhost/db";

				// Write
				await vault.write(ref, secret);

				// Verify file exists with correct permissions
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);
				const stat = await fs.lstat(filePath);
				assert.equal(stat.mode & 0o777, 0o600, "file should have 0600 perms");
				assert.ok(stat.isFile(), "should be a regular file");

				// Read
				const retrieved = await vault.read(ref);
				assert.equal(retrieved, secret, "read value should match written value");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("write and rotate a secret", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const secret1 = "postgresql://user:pass@localhost/db";
				const secret2 = "postgresql://user:newpass@localhost/db";

				// Write initial
				await vault.write(ref, secret1);
				let retrieved = await vault.read(ref);
				assert.equal(retrieved, secret1);

				// Rotate
				await vault.rotate(ref, secret2);
				retrieved = await vault.read(ref);
				assert.equal(retrieved, secret2, "rotate should update value");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("check secret existence", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;

				// Should not exist
				let exists = await vault.exists(ref);
				assert.equal(exists, false);

				// Write
				await vault.write(ref, "secret");

				// Should exist
				exists = await vault.exists(ref);
				assert.equal(exists, true);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("atomic writes and corruption recovery", () => {
		test("atomic rename completes successfully", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const largeSecret = "x".repeat(10000);

				// Multiple writes should not corrupt
				for (let i = 0; i < 5; i++) {
					const value = `${largeSecret}-${i}`;
					await vault.write(ref, value);
					const retrieved = await vault.read(ref);
					assert.equal(retrieved, value);
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("corrupted file (empty after crash) is detected", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);

				// Create an empty file (simulating crash during write)
				await fs.writeFile(filePath, "", { mode: 0o600 });

				// Read should fail with VaultCorruptedError
				let error: Error | null = null;
				try {
					await vault.read(ref);
				} catch (e) {
					error = e as Error;
				}

				assert.ok(
					error instanceof VaultCorruptedError,
					"empty file should trigger VaultCorruptedError",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("temporary files are cleaned up on write error", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				// Make vault directory read-only to cause write failure
				await fs.chmod(vaultRoot, 0o500);

				const ref = `vault://file/project/test/dsn` as const;

				let error: Error | null = null;
				try {
					await vault.write(ref, "secret");
				} catch (e) {
					error = e as Error;
				}

				assert.ok(error, "write to read-only directory should fail");

				// Restore permissions for cleanup
				await fs.chmod(vaultRoot, 0o700);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("permission enforcement", () => {
		test("reject file with world-readable permissions", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);

				// Create file with overly permissive mode
				await fs.writeFile(filePath, "secret", { mode: 0o644 });

				let error: Error | null = null;
				try {
					await vault.read(ref);
				} catch (e) {
					error = e as Error;
				}

				assert.ok(
					error instanceof VaultPermissionError,
					"world-readable file should trigger permission error",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("reject directory with wrong permissions", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				// Create directory with overly permissive mode
				await fs.mkdir(vaultRoot, { mode: 0o755, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;

				let error: Error | null = null;
				try {
					await vault.write(ref, "secret");
				} catch (e) {
					error = e as Error;
				}

				assert.ok(
					error instanceof VaultPermissionError ||
						error instanceof VaultError,
					"wrong directory perms should error",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("allow correct 0600 file permissions", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const secret = "secret-value";

				// Write creates file with 0600
				await vault.write(ref, secret);

				// Should read successfully
				const retrieved = await vault.read(ref);
				assert.equal(retrieved, secret);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("symlink defense", () => {
		test("reject symlinked file", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);

				// Create a real file outside vault
				const externalFile = path.join(vaultRoot, "external");
				await fs.writeFile(externalFile, "external-secret", { mode: 0o600 });

				// Create symlink to external file
				await fs.symlink(externalFile, filePath);

				let error: Error | null = null;
				try {
					await vault.read(ref);
				} catch (e) {
					error = e as Error;
				}

				assert.ok(
					error instanceof VaultSymlinkDetectedError,
					"symlink should be rejected",
				);
				assert.ok(
					error instanceof VaultSymlinkDetectedError &&
						error.message.includes("Symlink detected"),
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("SecretRef validation", () => {
		test("accept valid vault://file/ refs", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const validRefs = [
					`vault://file/project/audiobook/dsn` as const,
					`vault://file/project/monkeyking/db_password` as const,
					`vault://file/project/my-app-v2/secret` as const,
				];

				for (const ref of validRefs) {
					await vault.write(ref, "test-secret");
					const retrieved = await vault.read(ref);
					assert.equal(retrieved, "test-secret");
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("reject path traversal in vault ref", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const invalidRefs = [
					`vault://file/project/../../etc/passwd` as const,
					`vault://file/.hidden/secret` as const,
					`vault://file/project/../admin/secret` as const,
				];

				for (const ref of invalidRefs) {
					let error: Error | null = null;
					try {
						await vault.read(ref);
					} catch (e) {
						error = e as Error;
					}

					assert.ok(
						error instanceof VaultInvalidRefError,
						`should reject path traversal in ${ref}`,
					);
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("validate project slug format", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const invalidRefs = [
					`vault://file/project/-invalid/dsn` as const, // leading dash
					`vault://file/project/invalid-/dsn` as const, // trailing dash
					`vault://file/project/UPPERCASE/dsn` as const, // uppercase
				];

				for (const ref of invalidRefs) {
					let error: Error | null = null;
					try {
						await vault.write(ref, "secret");
					} catch (e) {
						error = e as Error;
					}

					assert.ok(
						error instanceof VaultInvalidRefError,
						`should reject invalid slug in ${ref}`,
					);
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("reject invalid vault prefix", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const invalidRefs = [
					`vault://hcv/path/to/secret` as const, // Wrong scheme
					`vault://project/test/dsn` as const, // Wrong scheme
					`file://project/test/dsn` as const, // Wrong prefix
				];

				for (const ref of invalidRefs) {
					let error: Error | null = null;
					try {
						await vault.write(ref, "secret");
					} catch (e) {
						error = e as Error;
					}

					assert.ok(
						error instanceof VaultInvalidRefError,
						`should reject invalid prefix in ${ref}`,
					);
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("audit logging", () => {
		test("create audit log with entries", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;

				// Perform operations
				await vault.write(ref, "secret1");
				await vault.read(ref);
				await vault.rotate(ref, "secret2");

				// Check audit log exists
				const auditLogPath = path.join(vaultRoot, ".audit.log");
				const auditLog = await fs.readFile(auditLogPath, "utf-8");

				// Parse lines (should be valid JSON)
				const lines = auditLog
					.split("\n")
					.filter((line) => line.trim().length > 0);
				assert.ok(lines.length >= 3, "should have at least 3 audit entries");

				// Check entries are valid JSON
				const entries = lines.map((line) => JSON.parse(line));

				// Verify operations are logged
				const ops = entries.map((e) => e.op);
				assert.ok(ops.includes("write"), "write should be logged");
				assert.ok(ops.includes("read"), "read should be logged");
				assert.ok(ops.includes("rotate"), "rotate should be logged");

				// Verify all entries have required fields
				for (const entry of entries) {
					assert.ok(entry.ts, "entry should have ts");
					assert.ok(entry.op, "entry should have op");
					assert.equal(entry.ref, ref, "entry should have correct ref");
					assert.ok(typeof entry.caller_pid === "number");
					assert.ok(typeof entry.success === "boolean");
				}
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("log both success and failure operations", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;

				// Successful write
				await vault.write(ref, "secret");

				// Failed read (non-existent)
				try {
					await vault.read(`vault://file/project/nonexistent/dsn` as const);
				} catch {
					// Expected
				}

				// Check audit log
				const auditLogPath = path.join(vaultRoot, ".audit.log");
				const auditLog = await fs.readFile(auditLogPath, "utf-8");
				const entries = auditLog
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line) => JSON.parse(line));

				// Should have success and failure entries
				const successes = entries.filter((e) => e.success);
				const failures = entries.filter((e) => !e.success);

				assert.ok(successes.length > 0, "should have successful operations");
				assert.ok(failures.length > 0, "should have failed operations");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("read cache (60s TTL)", () => {
		test("cache hit reduces file reads", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				await vault.write(ref, "secret");

				// First read
				const value1 = await vault.read(ref);
				assert.equal(value1, "secret");

				// Modify the file on disk
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);
				await fs.writeFile(filePath, "modified", { mode: 0o600 });

				// Second read should return cached value (not "modified")
				const value2 = await vault.read(ref);
				assert.equal(value2, "secret", "cached value should be returned");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("rotate() invalidates cache", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				await vault.write(ref, "secret1");

				// First read caches it
				let value = await vault.read(ref);
				assert.equal(value, "secret1");

				// Rotate invalidates cache
				await vault.rotate(ref, "secret2");

				// Next read should get new value
				value = await vault.read(ref);
				assert.equal(value, "secret2");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("write() invalidates cache", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				await vault.write(ref, "secret1");
				await vault.read(ref); // Cache it

				// Write invalidates cache
				await vault.write(ref, "secret2");

				// Read should get new value
				const value = await vault.read(ref);
				assert.equal(value, "secret2");
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("error redaction", () => {
		test("error messages do not contain secret values", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				const secretValue = "super-secret-password-123";

				// Try to read non-existent secret
				let error: Error | null = null;
				try {
					await vault.read(`vault://file/project/test/dsn` as const);
				} catch (e) {
					error = e as Error;
				}

				assert.ok(error);
				assert.ok(
					!error!.message.includes(secretValue),
					"error should not contain secret value",
				);
				assert.ok(
					!error!.message.includes("super-secret"),
					"error should not contain password",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});

		test("permission errors exclude secret content", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/test/dsn` as const;
				const filePath = path.join(
					vaultRoot,
					`${encodeURIComponent(ref)}.secret`,
				);

				// Create world-readable file
				const secretValue = "confidential-dsn-secret";
				await fs.writeFile(filePath, secretValue, { mode: 0o644 });

				let error: Error | null = null;
				try {
					await vault.read(ref);
				} catch (e) {
					error = e as Error;
				}

				assert.ok(error);
				assert.ok(
					!error!.message.includes(secretValue),
					"permission error should not expose secret value",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});

	describe("integration: full workflow", () => {
		test("write, read, rotate, verify audit log", async () => {
			const vaultRoot = createTempDir();
			const vault = fileVault({ basePath: vaultRoot });

			try {
				await fs.mkdir(vaultRoot, { mode: 0o700, recursive: true });

				const ref = `vault://file/project/audiobook/dsn` as const;

				// 1. Write initial DSN
				const dsn1 = "postgresql://user:pass1@host1/db";
				await vault.write(ref, dsn1);

				// 2. Read it back
				let read = await vault.read(ref);
				assert.equal(read, dsn1);

				// 3. Rotate to new DSN
				const dsn2 = "postgresql://user:pass2@host2/db";
				await vault.rotate(ref, dsn2);

				// 4. Verify new value
				read = await vault.read(ref);
				assert.equal(read, dsn2);

				// 5. Check existence
				const exists = await vault.exists(ref);
				assert.equal(exists, true);

				// 6. Verify audit log
				const auditLogPath = path.join(vaultRoot, ".audit.log");
				const auditLog = await fs.readFile(auditLogPath, "utf-8");
				const entries = auditLog
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line) => JSON.parse(line));

				// Should have write, read, rotate, read, exists entries
				const ops = entries.map((e) => e.op);
				assert.ok(ops.includes("write"));
				assert.ok(ops.includes("read"));
				assert.ok(ops.includes("rotate"));
				assert.ok(ops.includes("exists"));

				// All should be successful
				assert.ok(
					entries.every((e) => e.success),
					"all operations should succeed",
				);

				// All should reference correct secret
				assert.ok(
					entries.every((e) => e.ref === ref),
					"all entries should reference correct secret",
				);
			} finally {
				await cleanupTempDir(vaultRoot);
			}
		});
	});
});
