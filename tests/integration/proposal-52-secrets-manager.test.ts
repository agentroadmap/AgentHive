/**
 * proposal-52: Secrets Management & Scanning - Test Suite
 * Tests for EncryptedVault, SecretsScanner, and Pre-commit Hook Generation
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { VaultConfig } from "../../src/core/security/secrets-manager.ts";
import {
	EncryptedVault,
	generatePreCommitHook,
	SECRET_PATTERNS,
	SecretsScanner,
} from "../../src/core/security/secrets-manager.ts";

// ===== TEST UTILITIES =====

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
}

function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ===== ENCRYPTED VAULT TESTS =====

describe("EncryptedVault", () => {
	let tempDir: string;
	let config: VaultConfig;
	let vault: EncryptedVault;

	beforeEach(() => {
		tempDir = createTempDir();
		config = {
			vaultPath: path.join(tempDir, "vault.json"),
			masterKeyPath: path.join(tempDir, "master.key"),
		};
		vault = new EncryptedVault(config);
	});

	afterEach(() => {
		vault.destroy();
		cleanupTempDir(tempDir);
	});

	describe("AC#2: API keys stored in encrypted vault", () => {
		it("creates master key file on first run", () => {
			assert.ok(
				fs.existsSync(config.masterKeyPath),
				"Master key file should exist",
			);
			const keyData = fs.readFileSync(config.masterKeyPath);
			assert.equal(keyData.length, 32, "Master key should be 32 bytes");
		});

		it("stores and retrieves a secret", () => {
			vault.store("API_KEY", "test-secret-value-12345");
			const retrieved = vault.retrieve("API_KEY");
			assert.equal(retrieved, "test-secret-value-12345");
		});

		it("stores multiple secrets independently", () => {
			vault.store("KEY_1", "value1");
			vault.store("KEY_2", "value2");
			vault.store("KEY_3", "value3");

			assert.equal(vault.retrieve("KEY_1"), "value1");
			assert.equal(vault.retrieve("KEY_2"), "value2");
			assert.equal(vault.retrieve("KEY_3"), "value3");
		});

		it("returns null for non-existent secret", () => {
			const result = vault.retrieve("NONEXISTENT");
			assert.equal(result, null);
		});

		it("persists secrets to disk", () => {
			vault.store("PERSIST_KEY", "persistent-value");

			// Create new vault instance pointing to same files
			vault.destroy();
			const vault2 = new EncryptedVault(config);

			assert.equal(vault2.retrieve("PERSIST_KEY"), "persistent-value");
			vault2.destroy();
		});

		it("encrypted vault file does not contain plaintext", () => {
			vault.store("SECRET", "super-secret-value");

			const vaultData = JSON.parse(fs.readFileSync(config.vaultPath, "utf-8"));
			const vaultStr = JSON.stringify(vaultData);

			assert.ok(
				!vaultStr.includes("super-secret-value"),
				"Vault should not contain plaintext secret",
			);
			assert.ok(
				vaultData.secrets.SECRET.encryptedValue,
				"Should have encrypted value",
			);
			assert.ok(vaultData.secrets.SECRET.iv, "Should have IV");
			assert.ok(vaultData.secrets.SECRET.tag, "Should have auth tag");
		});

		it("uses AES-256-GCM encryption", () => {
			vault.store("ENC_TEST", "test-encryption");

			const vaultData = JSON.parse(fs.readFileSync(config.vaultPath, "utf-8"));
			const entry = vaultData.secrets.ENC_TEST;

			assert.equal(
				entry.iv.length,
				24,
				"IV should be 12 bytes hex-encoded (24 chars)",
			);
			assert.equal(
				entry.tag.length,
				32,
				"Auth tag should be 16 bytes hex-encoded (32 chars)",
			);
		});

		it("stores secret metadata", () => {
			vault.store("META_KEY", "value", { owner: "carter", project: "test" });
			const meta = vault.getMetadata("META_KEY");

			assert.ok(meta);
			assert.equal(meta.metadata?.owner, "carter");
			assert.equal(meta.metadata?.project, "test");
		});

		it("tracks creation and update timestamps", () => {
			const before = Date.now();
			vault.store("TIME_KEY", "value1");
			const after = Date.now();

			const meta = vault.getMetadata("TIME_KEY");
			assert.ok(meta);
			assert.ok(meta.createdAt >= before && meta.createdAt <= after);
			assert.ok(meta.updatedAt >= before && meta.updatedAt <= after);
		});

		it("emits secret:stored event", (_, done) => {
			vault.on("secret:stored", (event) => {
				assert.equal(event.key, "EVENT_KEY");
				assert.equal(event.rotationCount, 0);
				done();
			});
			vault.store("EVENT_KEY", "value");
		});
	});

	describe("AC#4: Key rotation with zero downtime", () => {
		it("rotates secret encryption without data loss", () => {
			vault.store("ROTATE_KEY", "original-value");
			const originalMeta = vault.getMetadata("ROTATE_KEY");

			vault.rotate("ROTATE_KEY", "new-value");

			assert.equal(vault.retrieve("ROTATE_KEY"), "new-value");
			const newMeta = vault.getMetadata("ROTATE_KEY");
			assert.equal(
				newMeta?.rotationCount,
				(originalMeta?.rotationCount || 0) + 1,
			);
		});

		it("preserves creation time on rotation", () => {
			vault.store("KEEP_TIME_KEY", "value1");
			const originalMeta = vault.getMetadata("KEEP_TIME_KEY");

			vault.rotate("KEEP_TIME_KEY", "value2");

			const newMeta = vault.getMetadata("KEEP_TIME_KEY");
			assert.equal(newMeta?.createdAt, originalMeta?.createdAt);
		});

		it("uses new IV on rotation", () => {
			vault.store("IV_KEY", "value");
			const data1 = JSON.parse(fs.readFileSync(config.vaultPath, "utf-8"));
			const iv1 = data1.secrets.IV_KEY.iv;

			vault.rotate("IV_KEY", "value");
			const data2 = JSON.parse(fs.readFileSync(config.vaultPath, "utf-8"));
			const iv2 = data2.secrets.IV_KEY.iv;

			assert.notEqual(iv1, iv2, "IV should change on rotation");
		});

		it("emits secret:rotated event", (_, done) => {
			vault.store("ROT_EVENT", "v1");

			vault.on("secret:rotated", (event) => {
				assert.equal(event.secretId, vault.getMetadata("ROT_EVENT")?.id);
				assert.ok(event.success);
				done();
			});

			vault.rotate("ROT_EVENT", "v2");
		});

		it("increments rotation count", () => {
			vault.store("COUNT_KEY", "v1");

			vault.rotate("COUNT_KEY", "v2");
			vault.rotate("COUNT_KEY", "v3");

			const meta = vault.getMetadata("COUNT_KEY");
			// store() sets rotationCount to 0, each rotate() increments by 1
			assert.equal(meta?.rotationCount, 2);
		});
	});

	describe("Vault operations", () => {
		it("lists all keys without exposing values", () => {
			vault.store("KEY_A", "secret-a");
			vault.store("KEY_B", "secret-b");
			vault.store("KEY_C", "secret-c");

			const keys = vault.listKeys();
			assert.deepEqual(keys.sort(), ["KEY_A", "KEY_B", "KEY_C"]);
		});

		it("checks if key exists", () => {
			vault.store("EXIST_KEY", "value");

			assert.ok(vault.has("EXIST_KEY"));
			assert.ok(!vault.has("MISSING_KEY"));
		});

		it("deletes a secret", () => {
			vault.store("DELETE_KEY", "value");
			assert.ok(vault.has("DELETE_KEY"));

			const deleted = vault.delete("DELETE_KEY");
			assert.ok(deleted);
			assert.ok(!vault.has("DELETE_KEY"));
		});

		it("emits secret:deleted event", (_, done) => {
			vault.store("DEL_KEY", "value");

			vault.on("secret:deleted", (event) => {
				assert.equal(event.key, "DEL_KEY");
				done();
			});

			vault.delete("DEL_KEY");
		});

		it("handles special characters in values", () => {
			const specialValue = "p@ssw0rd!#$%^&*()_+-=[]{}|;:,.<>?/~`";
			vault.store("SPECIAL_KEY", specialValue);
			assert.equal(vault.retrieve("SPECIAL_KEY"), specialValue);
		});

		it("handles unicode in values", () => {
			const unicodeValue = "🔑🗝️パスワード密码";
			vault.store("UNICODE_KEY", unicodeValue);
			assert.equal(vault.retrieve("UNICODE_KEY"), unicodeValue);
		});

		it("destroys vault securely", () => {
			vault.store("DESTROY_KEY", "sensitive");
			vault.destroy();

			// After destroy, trying to use vault should not return secrets
			// (Implementation clears in-memory proposal)
		});
	});
});

// ===== SECRETS SCANNER TESTS =====

describe("SecretsScanner", () => {
	let scanner: SecretsScanner;
	let tempDir: string;

	beforeEach(() => {
		scanner = new SecretsScanner();
		tempDir = createTempDir();
	});

	afterEach(() => {
		cleanupTempDir(tempDir);
	});

	describe("AC#1: Secrets scanning runs before proposal file writes", () => {
		it("detects API keys", () => {
			const content =
				'const apiKey = "sk_test_1234567890abcdef1234567890abcdef"';
			const result = scanner.scanContent(content, "test.ts");

			assert.ok(!result.clean, "Should detect API key");
			assert.ok(result.matches.length > 0);
		});

		it("detects secret keys", () => {
			const content = 'const secretKey = "my-super-secret-key-123456789012"';
			const result = scanner.scanContent(content, "config.ts");

			assert.ok(!result.clean, "Should detect secret key");
			assert.ok(result.matches.some((m) => m.pattern === "SECRET_KEY"));
		});

		it("detects bearer tokens", () => {
			const content =
				"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
			const result = scanner.scanContent(content, "api.ts");

			assert.ok(!result.clean, "Should detect bearer token");
		});

		it("detects passwords in config", () => {
			const content = 'password: "myPassword123"';
			const result = scanner.scanContent(content, "config.json");

			assert.ok(!result.clean, "Should detect password");
		});

		it("detects AWS access keys", () => {
			const content = "AccessKey: AKIAIOSFODNN7EXAMPLE";
			const result = scanner.scanContent(content, "aws.ts");

			assert.ok(!result.clean, "Should detect AWS access key");
			assert.ok(result.matches.some((m) => m.pattern === "AWS_ACCESS_KEY"));
		});

		it("detects GitLab tokens", () => {
			const content = "token: glpat-xxxxxxxxxxxxxxxxxxxx";
			const result = scanner.scanContent(content, "gitlab.ts");

			assert.ok(!result.clean, "Should detect GitLab token");
		});

		it("detects GitHub tokens", () => {
			const content = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
			const result = scanner.scanContent(content, "github.ts");

			assert.ok(!result.clean, "Should detect GitHub token");
		});

		it("detects private keys", () => {
			const content =
				"-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----";
			const result = scanner.scanContent(content, "key.pem");

			assert.ok(!result.clean, "Should detect private key");
			assert.ok(result.matches.some((m) => m.pattern === "PRIVATE_KEY"));
			assert.equal(result.matches[0].severity, "critical");
		});

		it("detects database URLs with credentials", () => {
			const content = "postgres://user:secretpassword@localhost:5432/mydb";
			const result = scanner.scanContent(content, "db.ts");

			assert.ok(!result.clean, "Should detect database URL");
			assert.ok(result.matches.some((m) => m.pattern === "DATABASE_URL"));
		});

		it("returns clean result for clean content", () => {
			const content = 'const greeting = "Hello World";\nconst count = 42;';
			const result = scanner.scanContent(content, "clean.ts");

			assert.ok(result.clean, "Clean content should pass");
			assert.equal(result.matches.length, 0);
		});

		it("reports line numbers correctly", () => {
			const content = [
				"const a = 1;",
				"const b = 2;",
				'const secretKey = "my-secret-key-1234567890123";',
				"const c = 3;",
			].join("\n");

			const result = scanner.scanContent(content, "lines.ts");
			assert.ok(result.matches.length > 0);
			assert.equal(result.matches[0].line, 3);
		});

		it("tracks scan time", () => {
			const content = "const x = 1;";
			const result = scanner.scanContent(content, "time.ts");

			assert.ok(result.scanTime >= 0, "Scan time should be non-negative");
		});

		it("scans multiple patterns in one file", () => {
			const content = `
        apiKey: "sk_test_1234567890abcdef1234567890abcdef"
        password: "mypassword"
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token.here"
      `;

			const result = scanner.scanContent(content, "multi.ts");
			assert.ok(result.matches.length >= 2, "Should detect multiple patterns");
		});
	});

	describe("File scanning", () => {
		it("scans a single file", () => {
			const testFile = path.join(tempDir, "test.ts");
			fs.writeFileSync(
				testFile,
				'const secretKey = "my-secret-key-1234567890123";',
			);

			const result = scanner.scanFile(testFile);
			assert.ok(!result.clean);
			assert.equal(result.file, testFile);
		});

		it("handles non-existent file gracefully", () => {
			const result = scanner.scanFile("/nonexistent/file.ts");
			assert.ok(!result.clean);
			assert.ok(result.matches[0].pattern === "FILE_READ_ERROR");
		});

		it("scans multiple files", () => {
			const file1 = path.join(tempDir, "clean.ts");
			const file2 = path.join(tempDir, "dirty.ts");

			fs.writeFileSync(file1, "const x = 1;");
			fs.writeFileSync(
				file2,
				'const apiKey = "sk_test_1234567890abcdef1234567890abcdef";',
			);

			const results = scanner.scanFiles([file1, file2]);
			assert.equal(results.length, 2);
			assert.ok(results[0].clean, "First file should be clean");
			assert.ok(!results[1].clean, "Second file should have secrets");
		});

		it("scans directory recursively", () => {
			const subDir = path.join(tempDir, "src");
			fs.mkdirSync(subDir);

			fs.writeFileSync(path.join(tempDir, "root.ts"), "const x = 1;");
			fs.writeFileSync(path.join(subDir, "auth.ts"), 'password: "secret123"');

			const results = scanner.scanDirectory(tempDir);
			const dirtyResult = results.find((r) => !r.clean);
			assert.ok(dirtyResult, "Should find secret in subdirectory");
		});
	});

	describe("Custom patterns and ignore", () => {
		it("uses custom patterns", () => {
			const customScanner = new SecretsScanner({
				customPatterns: [
					{
						pattern: /CUSTOM_SECRET_[A-Z0-9]+/g,
						name: "CUSTOM_SECRET",
						severity: "high",
					},
				],
			});

			const result = customScanner.scanContent(
				"token: CUSTOM_SECRET_ABC123",
				"custom.ts",
			);
			assert.ok(!result.clean);
			assert.ok(result.matches.some((m) => m.pattern === "CUSTOM_SECRET"));
		});

		it("respects ignore patterns", () => {
			const ignoreScanner = new SecretsScanner({
				ignorePatterns: [/test/i],
			});

			const content = '// test: password="ignorethis"'; // Line containing "test" should be ignored
			const result = ignoreScanner.scanContent(content, "ignore.ts");
			// The ignore pattern should skip lines containing "test"
			assert.ok(
				result.clean || result.matches.length === 0,
				"Ignored lines should not produce matches",
			);
		});
	});

	describe("Severity levels", () => {
		it("marks private keys as critical", () => {
			const content = "-----BEGIN RSA PRIVATE KEY-----";
			const result = scanner.scanContent(content, "key.pem");
			assert.ok(result.matches.some((m) => m.severity === "critical"));
		});

		it("marks API keys as high", () => {
			const content = 'apiKey: "sk_test_1234567890abcdef1234567890abcdef"';
			const result = scanner.scanContent(content, "config.ts");
			assert.ok(result.matches.some((m) => m.severity === "high"));
		});
	});
});

// ===== PRE-COMMIT HOOK TESTS =====

describe("Pre-commit Hook Generation", () => {
	it("generates valid bash script", () => {
		const hook = generatePreCommitHook();

		assert.ok(hook.startsWith("#!/bin/bash"), "Should start with shebang");
		assert.ok(hook.includes("git diff --cached"), "Should check staged files");
		assert.ok(hook.includes("SecretsScanner"), "Should use scanner");
	});

	it("includes severity filtering", () => {
		const hook = generatePreCommitHook({ failOnSeverity: "critical" });

		assert.ok(hook.includes("minSeverity"), "Should filter by severity");
	});

	it("includes custom patterns when provided", () => {
		const hook = generatePreCommitHook({
			scannerConfig: {
				customPatterns: [
					{
						pattern: /CUSTOM/g,
						name: "CUSTOM",
						severity: "high",
					},
				],
			},
		});

		assert.ok(hook.length > 0, "Should generate hook with custom config");
	});

	it("exits with error on secrets found", () => {
		const hook = generatePreCommitHook();

		assert.ok(
			hook.includes("exit 1"),
			"Should exit with error code 1 on secrets",
		);
		assert.ok(hook.includes("exit 0"), "Should exit with 0 when clean");
	});
});

// ===== SECRET PATTERNS TESTS =====

describe("SECRET_PATTERNS", () => {
	it("exports comprehensive pattern list", () => {
		assert.ok(SECRET_PATTERNS.length >= 10, "Should have at least 10 patterns");
	});

	it("includes high-severity patterns", () => {
		const criticalPatterns = SECRET_PATTERNS.filter(
			(p) => p.severity === "critical",
		);
		assert.ok(
			criticalPatterns.length >= 5,
			"Should have multiple critical patterns",
		);
	});

	it("each pattern has required fields", () => {
		for (const pattern of SECRET_PATTERNS) {
			assert.ok(pattern.pattern instanceof RegExp);
			assert.ok(typeof pattern.name === "string");
			assert.ok(
				["low", "medium", "high", "critical"].includes(pattern.severity),
			);
		}
	});
});

// ===== INTEGRATION TESTS =====

describe("Integration: Vault + Scanner", () => {
	let tempDir: string;
	let vault: EncryptedVault;
	let scanner: SecretsScanner;

	beforeEach(() => {
		tempDir = createTempDir();
		vault = new EncryptedVault({
			vaultPath: path.join(tempDir, "vault.json"),
			masterKeyPath: path.join(tempDir, "master.key"),
		});
		scanner = new SecretsScanner();
	});

	afterEach(() => {
		vault.destroy();
		cleanupTempDir(tempDir);
	});

	it("scanner detects secrets that should be in vault", () => {
		// Simulate accidental commit of secret
		const content =
			'const apiKey = "sk_test_1234567890abcdef1234567890abcdef";';
		const scanResult = scanner.scanContent(content, "config.ts");

		assert.ok(!scanResult.clean, "Scanner should detect the leaked secret");

		// Store properly in vault instead
		vault.store("API_KEY", "sk_test_1234567890abcdef1234567890abcdef");
		assert.equal(
			vault.retrieve("API_KEY"),
			"sk_test_1234567890abcdef1234567890abcdef",
		);
	});

	it("rotation maintains security", () => {
		const originalKey = "original-api-key-value-1234";
		vault.store("API_KEY", originalKey);

		// Rotate to new key
		const newKey = "rotated-api-key-value-5678";
		vault.rotate("API_KEY", newKey);

		// Verify old value is gone
		const data = JSON.parse(
			fs.readFileSync(path.join(tempDir, "vault.json"), "utf-8"),
		);
		assert.ok(
			!JSON.stringify(data).includes(originalKey),
			"Old key should not be in vault",
		);

		// Verify new value works
		assert.equal(vault.retrieve("API_KEY"), newKey);
	});
});
