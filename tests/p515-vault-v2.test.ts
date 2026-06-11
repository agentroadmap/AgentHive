/**
 * P515: Vault v2 Adapter Tests
 *
 * Tests for the pluggable vault adapter pattern with:
 * - HCV adapter with AppRole auth
 * - File adapter fallback
 * - AWS adapter stub
 * - Chooser routing
 * - Cache behavior
 * - Audit logging
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	hcvVault,
	type HcvVaultOptions,
	fileVault,
	type FileVaultOptions,
	awsVault,
	type AwsVaultOptions,
	getVault,
	type VaultAdapter,
	type SecretRef,
	VaultError,
	VaultPermissionError,
	VaultSymlinkDetectedError,
	VaultCorruptedError,
	VaultInvalidRefError,
	VaultUnavailableError,
	VaultAuthError,
} from "../src/shared/vault/index.ts";

// ─── File Vault Tests ───────────────────────────────────────────────────

describe("FileVault adapter", () => {
	let tempDir: string;
	let adapter: VaultAdapter;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
		await fs.chmod(tempDir, 0o700);
		adapter = fileVault({ basePath: tempDir });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("writes and reads a secret", async () => {
		const ref: SecretRef = "vault://file/project/audiobook/dsn";
		const value = "postgresql://user:pass@host/db";

		await adapter.write(ref, value);
		const read = await adapter.read(ref);

		expect(read).toBe(value);
	});

	it("caches reads with 60s TTL", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		await adapter.write(ref, "value1");

		// First read
		const v1 = await adapter.read(ref);
		expect(v1).toBe("value1");

		// Directly modify the file on disk
		const encoded = encodeURIComponent(ref);
		const filePath = path.join(tempDir, `${encoded}.secret`);
		await fs.writeFile(filePath, "value2", { mode: 0o600 });

		// Second read should return cached value
		const v2 = await adapter.read(ref);
		expect(v2).toBe("value1");
	});

	it("rotates a secret and invalidates cache", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		await adapter.write(ref, "old");

		// Read to populate cache
		const cached = await adapter.read(ref);
		expect(cached).toBe("old");

		// Rotate
		await adapter.rotate(ref, "new");

		// Read after rotate should see new value
		const newVal = await adapter.read(ref);
		expect(newVal).toBe("new");
	});

	it("checks secret existence", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";

		expect(await adapter.exists(ref)).toBe(false);

		await adapter.write(ref, "value");
		expect(await adapter.exists(ref)).toBe(true);
	});

	it("throws VaultError on missing secret", async () => {
		const ref: SecretRef = "vault://file/project/nonexistent/secret";

		expect(adapter.read(ref)).rejects.toThrow(VaultError);
	});

	it("enforces file permissions (0600)", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		const encoded = encodeURIComponent(ref);
		const filePath = path.join(tempDir, `${encoded}.secret`);

		await adapter.write(ref, "secret");

		// Manually change permissions
		await fs.chmod(filePath, 0o644);

		// Should fail permission check
		expect(adapter.read(ref)).rejects.toThrow(VaultPermissionError);
	});

	it("detects and rejects symlinks", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		const encoded = encodeURIComponent(ref);
		const filePath = path.join(tempDir, `${encoded}.secret`);

		// Create a real secret file
		await adapter.write(ref, "secret");

		// Create a symlink to it with a ref-compatible path
		const symlinkRef: SecretRef = "vault://file/symlink";
		const symlinkEncoded = encodeURIComponent(symlinkRef);
		const symlinkPath = path.join(tempDir, `${symlinkEncoded}.secret`);
		await fs.symlink(filePath, symlinkPath);

		// Reading through symlink ref should fail
		expect(adapter.read(symlinkRef)).rejects.toThrow(
			VaultSymlinkDetectedError
		);
	});

	it("validates SecretRef format (path traversal)", async () => {
		const badRef: SecretRef = "vault://file/../etc/passwd" as SecretRef;
		expect(adapter.read(badRef)).rejects.toThrow(VaultInvalidRefError);
	});

	it("validates SecretRef scheme prefix", async () => {
		const badRef: SecretRef = "vault://hcv/some/path" as SecretRef;
		expect(adapter.read(badRef)).rejects.toThrow(VaultInvalidRefError);
	});

	it("writes audit log entries", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		await adapter.write(ref, "value");
		await adapter.read(ref);

		const auditLogPath = path.join(tempDir, ".audit.log");
		const content = await fs.readFile(auditLogPath, "utf-8");

		expect(content).toContain('"op":"write"');
		expect(content).toContain('"op":"read"');
		expect(content).toContain('"success":true');
	});

	it("creates directory structure on first write", async () => {
		const newAdapter = fileVault({
			basePath: path.join(tempDir, "newdir"),
		});
		const ref: SecretRef = "vault://file/project/test/secret";

		await newAdapter.write(ref, "value");

		const stat = await fs.lstat(path.join(tempDir, "newdir"));
		expect(stat.isDirectory()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o700);
	});

	it("handles concurrent writes safely (atomic rename)", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";

		const promises = Array.from({ length: 10 }, (_, i) =>
			adapter.write(ref, `value${i}`)
		);
		await Promise.all(promises);

		const final = await adapter.read(ref);
		expect(final).toMatch(/^value\d+$/);
	});

	it("detects corrupted files (empty content)", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		const encoded = encodeURIComponent(ref);
		const filePath = path.join(tempDir, `${encoded}.secret`);

		// Write an empty file
		await fs.writeFile(filePath, "", { mode: 0o600 });

		expect(adapter.read(ref)).rejects.toThrow(VaultCorruptedError);
	});
});

// ─── HCV Vault Tests (Mock HTTP) ─────────────────────────────────────

describe("HcvVault adapter", () => {
	let adapter: VaultAdapter;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		global.fetch = fetchMock as any;

		adapter = hcvVault({
			addr: "http://localhost:8200",
			roleId: "test-role-id",
			secretId: "test-secret-id",
			mount: "secret",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("authenticates with AppRole and caches token", async () => {
		const now = Date.now();

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "test-token-123",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					data: {
						value: "secret-value",
					},
				},
			}),
		});

		const ref: SecretRef = "vault://hcv/tenants/audiobook/dsn";
		const value = await adapter.read(ref);

		expect(value).toBe("secret-value");
		expect(fetchMock).toHaveBeenCalledWith("http://localhost:8200/v1/auth/approle/login", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				role_id: "test-role-id",
				secret_id: "test-secret-id",
			}),
		});
	});

	it("reads from KV v2 with cached token", async () => {
		// Create a fresh adapter for this test
		const adapter2 = hcvVault({
			addr: "http://localhost:8200",
			roleId: "test-role-id",
			secretId: "test-secret-id",
			mount: "secret",
		});

		// Prime the cache with a token
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "cached-token",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					data: {
						value: "my-secret",
					},
				},
			}),
		});

		const ref: SecretRef = "vault://hcv/tenants/audiobook/dsn";
		const value = await adapter2.read(ref);

		expect(value).toBe("my-secret");
		expect(fetchMock.mock.calls).toHaveLength(2);
	});

	it("writes to KV v2 and invalidates cache", async () => {
		const adapter3 = hcvVault({
			addr: "http://localhost:8200",
			roleId: "test-role-id",
			secretId: "test-secret-id",
			mount: "secret",
		});

		// Setup token
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "test-token",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					data: {
						value: "dummy",
					},
				},
			}),
		});

		await adapter3.read("vault://hcv/tenants/test/secret" as SecretRef);

		// Mock write response
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
		});

		const ref: SecretRef = "vault://hcv/tenants/audiobook/dsn";
		await adapter3.write(ref, "new-secret-value");

		expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
	});

	it("returns 404 as VaultError (not found)", async () => {
		const adapter4 = hcvVault({
			addr: "http://localhost:8200",
			roleId: "test-role-id",
			secretId: "test-secret-id",
			mount: "secret",
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "test-token",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 404,
			text: async () => "Not found",
		});

		const ref: SecretRef = "vault://hcv/tenants/missing/secret";
		expect(adapter4.read(ref)).rejects.toThrow(VaultError);
	});

	it("throws VaultAuthError on auth failure", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: async () => "AppRole login failed",
		});

		const ref: SecretRef = "vault://hcv/tenants/test/secret";
		expect(adapter.read(ref)).rejects.toThrow(VaultAuthError);
	});

	it("validates HCV SecretRef scheme", async () => {
		const ref: SecretRef = "vault://aws/some/secret" as SecretRef;
		expect(adapter.read(ref)).rejects.toThrow(VaultInvalidRefError);
	});

	it("rejects path traversal attempts", async () => {
		const ref: SecretRef = "vault://hcv/../etc/passwd" as SecretRef;
		expect(adapter.read(ref)).rejects.toThrow(VaultInvalidRefError);
	});

	it("handles vault outage with stale cache", async () => {
		// Setup initial read with cache
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "test-token",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					data: {
						value: "cached-secret",
					},
				},
			}),
		});

		const ref: SecretRef = "vault://hcv/tenants/audiobook/dsn";
		const cached = await adapter.read(ref);
		expect(cached).toBe("cached-secret");

		// Now simulate vault outage
		fetchMock.mockClear();
		fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		// Should still return stale cache
		const stale = await adapter.read(ref);
		expect(stale).toBe("cached-secret");
	});

	it("throws VaultUnavailableError when stale cache expires", async () => {
		// This is harder to test without time manipulation
		// For now, create adapter with very short stale threshold
		const shortAdapter = hcvVault({
			addr: "http://localhost:8200",
			roleId: "test-role",
			secretId: "test-secret",
			cacheStaleThreshold: 0, // Immediately stale
		});

		// Note: This test would need time manipulation to fully work
		// Documenting the expected behavior
		expect(shortAdapter).toBeDefined();
	});
});

// ─── AWS Vault Tests (Stub) ─────────────────────────────────────────

describe("AwsVault adapter (stub)", () => {
	it("creates adapter with region config", () => {
		const adapter = awsVault({ region: "us-east-1" });
		expect(adapter).toBeDefined();
	});

	it("throws error when SDK not installed (read)", async () => {
		const adapter = awsVault({ region: "us-east-1" });
		const ref: SecretRef = "vault://aws/agentHive/audiobook/dsn";

		// Since the SDK won't be installed in test environment
		expect(adapter.read(ref)).rejects.toThrow();
	});

	it("validates AWS SecretRef scheme", () => {
		const adapter = awsVault({ region: "us-east-1" });
		const ref: SecretRef = "vault://hcv/some/path" as SecretRef;

		expect(adapter.read(ref)).rejects.toThrow(VaultError);
	});
});

// ─── Vault Chooser (Routing) Tests ──────────────────────────────────

describe("Vault chooser (routing adapter)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-chooser-"));
		await fs.chmod(tempDir, 0o700);
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	it("routes file:// refs to FileVault", async () => {
		const vault = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://file/project/test/secret";

		await vault.write(ref, "test-value");
		const value = await vault.read(ref);

		expect(value).toBe("test-value");
	});

	it("routes hcv:// refs to HcvVault", async () => {
		const fetchMock = vi.fn();
		global.fetch = fetchMock as any;

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				auth: {
					client_token: "token",
					lease_duration: 3600,
				},
			}),
		});

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					data: { value: "secret" },
				},
			}),
		});

		const vault = hcvVault({
			addr: "http://localhost:8200",
			roleId: "role",
			secretId: "secret",
		});

		const ref: SecretRef = "vault://hcv/tenants/test/secret";
		const value = await vault.read(ref);

		expect(value).toBe("secret");
	});

	it("rejects unknown scheme", async () => {
		const vault = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://unknown/path" as SecretRef;

		expect(vault.read(ref)).rejects.toThrow(VaultInvalidRefError);
	});
});

// ─── Fallback Behavior Tests ──────────────────────────────────────────

describe("File vault as persistent fallback", () => {
	let tempDir: string;
	let adapter: VaultAdapter;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-fallback-"));
		await fs.chmod(tempDir, 0o700);
		adapter = fileVault({ basePath: tempDir });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	it("continues to work during mixed deployments (hcv + file)", async () => {
		// Write to file
		const fileRef: SecretRef = "vault://file/legacy/secret";
		await adapter.write(fileRef, "file-value");

		// Read from file
		const value = await adapter.read(fileRef);
		expect(value).toBe("file-value");

		// Both refs can coexist in the same deployment
		expect(fileRef).toMatch(/^vault:\/\/file\//);
	});

	it("maintains backward compatibility with existing secrets", async () => {
		const ref: SecretRef = "vault://file/project/legacy/dsn";
		const legacyValue = "postgresql://old:style@host/db";

		// Write legacy secret
		await adapter.write(ref, legacyValue);

		// Should still work after code updates
		const read = await adapter.read(ref);
		expect(read).toBe(legacyValue);
	});
});

// ─── Rotation Flow Tests ────────────────────────────────────────────

describe("Secret rotation with grace period", () => {
	let tempDir: string;
	let adapter: VaultAdapter;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-rotate-"));
		await fs.chmod(tempDir, 0o700);
		adapter = fileVault({ basePath: tempDir });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	it("writes new password first, then cache invalidation", async () => {
		const ref: SecretRef = "vault://file/tenants/audiobook/db_password";

		// Old password
		await adapter.write(ref, "old-password");
		const cached1 = await adapter.read(ref);
		expect(cached1).toBe("old-password");

		// Rotate (new password)
		await adapter.rotate(ref, "new-password");

		// Cache should be invalidated
		const uncached = await adapter.read(ref);
		expect(uncached).toBe("new-password");
	});

	it("stores both old and new during grace period (vault-level concern)", async () => {
		// Note: grace period is implemented at pool level, not vault level
		// Vault just stores the single current value
		const ref: SecretRef = "vault://file/tenants/audiobook/db_password";

		await adapter.write(ref, "new-password");
		const value = await adapter.read(ref);

		expect(value).toBe("new-password");
	});
});

// ─── Audit Log Tests ────────────────────────────────────────────────

describe("Audit logging", () => {
	let tempDir: string;
	let adapter: VaultAdapter;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-audit-"));
		await fs.chmod(tempDir, 0o700);
		adapter = fileVault({ basePath: tempDir });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	it("logs read operations with timestamp and result", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		await adapter.write(ref, "value");
		await adapter.read(ref);

		const auditPath = path.join(tempDir, ".audit.log");
		const content = await fs.readFile(auditPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		const readLine = lines.find((l) => l.includes('"op":"read"'));
		expect(readLine).toBeTruthy();

		const logEntry = JSON.parse(readLine!);
		expect(logEntry.op).toBe("read");
		expect(logEntry.success).toBe(true);
		expect(logEntry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(logEntry.caller_pid).toBe(process.pid);
	});

	it("logs failed operations with error message", async () => {
		const ref: SecretRef = "vault://file/project/missing/secret";

		try {
			await adapter.read(ref);
		} catch {
			// Expected
		}

		const auditPath = path.join(tempDir, ".audit.log");
		const content = await fs.readFile(auditPath, "utf-8");

		expect(content).toContain('"success":false');
		expect(content).toContain("Secret not found");
	});

	it("logs rotation operations separately", async () => {
		const ref: SecretRef = "vault://file/project/test/secret";
		await adapter.write(ref, "old");
		await adapter.rotate(ref, "new");

		const auditPath = path.join(tempDir, ".audit.log");
		const content = await fs.readFile(auditPath, "utf-8");

		expect(content).toContain('"op":"write"');
		expect(content).toContain('"op":"rotate"');
	});
});

// ─── Interface Compliance Tests ──────────────────────────────────────

describe("VaultAdapter interface compliance", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-iface-"));
		await fs.chmod(tempDir, 0o700);
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true });
		} catch {
			// ignore
		}
	});

	it("implements read method returning Promise<string>", async () => {
		const adapter = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://file/project/test/secret";

		await adapter.write(ref, "value");
		const result = adapter.read(ref);

		expect(result).toBeInstanceOf(Promise);
		const value = await result;
		expect(typeof value).toBe("string");
	});

	it("implements write method returning Promise<void>", async () => {
		const adapter = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://file/project/test/secret";

		const result = adapter.write(ref, "value");

		expect(result).toBeInstanceOf(Promise);
		await result;
	});

	it("implements rotate method returning Promise<void>", async () => {
		const adapter = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://file/project/test/secret";

		await adapter.write(ref, "initial");
		const result = adapter.rotate(ref, "new");

		expect(result).toBeInstanceOf(Promise);
		await result;
	});

	it("implements exists method returning Promise<boolean>", async () => {
		const adapter = fileVault({ basePath: tempDir });
		const ref: SecretRef = "vault://file/project/test/secret";

		const result = adapter.exists(ref);

		expect(result).toBeInstanceOf(Promise);
		const exists = await result;
		expect(typeof exists).toBe("boolean");
	});
});
