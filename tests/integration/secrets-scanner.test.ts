/**
 * Tests for Secrets Management & Scanning (proposal-52)
 *
 * AC#1: Secrets scanning runs before proposal file writes
 * AC#2: API keys stored in encrypted vault, not environment vars
 * AC#3: Pre-commit hook scans for leaked credentials
 * AC#4: Key rotation mechanism with zero downtime
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	containsSecrets,
	EncryptedVault,
	generatePreCommitHook,
	maskSecrets,
	SecretsScanner,
} from "../../src/core/security/secrets-scanner.ts";

describe("EncryptedVault (proposal-52 AC#2, AC#4)", () => {
	let tempDir: string;
	let vault: EncryptedVault;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-vault-test-"));
		vault = new EncryptedVault({ vaultPath: tempDir });
		await vault.initialize();
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should initialize and create vault directory", async () => {
		const keyPath = join(tempDir, ".vault-key");
		// Key should be auto-generated
		const key = await readFile(keyPath, "utf-8");
		assert.ok(key.length === 64, "Key should be 64 hex chars (32 bytes)");
	});

	it("should store and retrieve secrets", async () => {
		await vault.setSecret("test-api-key", "sk-abc123def456", {
			service: "test",
		});
		const secret = vault.getSecret("test-api-key");

		assert.ok(secret, "Secret should exist");
		assert.equal(secret.value, "sk-abc123def456");
		assert.equal(secret.version, 1);
		assert.equal(secret.metadata?.service, "test");
	});

	it("should list secret keys without exposing values", async () => {
		await vault.setSecret("another-key", "secret-value");
		const keys = vault.listSecrets();

		assert.ok(keys.includes("test-api-key"), "Should include first key");
		assert.ok(keys.includes("another-key"), "Should include second key");
		// Verify values are not in the keys list
		assert.ok(
			!keys.includes("sk-abc123def456"),
			"Values should not appear in keys list",
		);
	});

	it("should update secret versions on overwrite", async () => {
		await vault.setSecret("test-api-key", "sk-new-value");
		const secret = vault.getSecret("test-api-key");

		assert.equal(secret?.version, 2, "Version should increment");
		assert.equal(secret?.value, "sk-new-value");
	});

	it("AC#4: should rotate secrets and archive old version", async () => {
		const rotated = await vault.rotateSecret(
			"test-api-key",
			"sk-rotated-value",
		);

		assert.equal(rotated.version, 3, "Version should increment after rotation");
		assert.equal(rotated.value, "sk-rotated-value");

		// Check archive file exists
		const archivePath = join(tempDir, "test-api-key.v2.archive");
		const archive = JSON.parse(await readFile(archivePath, "utf-8"));
		assert.equal(
			archive.version,
			2,
			"Archived version should be previous version",
		);
		assert.equal(
			archive.value,
			"sk-new-value",
			"Archived should have old value",
		);
	});

	it("should fail rotation for non-existent secret", async () => {
		await assert.rejects(
			() => vault.rotateSecret("nonexistent", "value"),
			/Secret 'nonexistent' not found/,
		);
	});

	it("should delete secrets", async () => {
		const deleted = await vault.deleteSecret("another-key");
		assert.ok(deleted, "Delete should return true");
		assert.equal(
			vault.getSecret("another-key"),
			null,
			"Deleted secret should not exist",
		);
	});

	it("should persist vault across re-initialization", async () => {
		const vault2 = new EncryptedVault({ vaultPath: tempDir });
		await vault2.initialize();

		const secret = vault2.getSecret("test-api-key");
		assert.ok(secret, "Secret should survive re-init");
		assert.equal(secret?.version, 3);
		assert.equal(secret?.value, "sk-rotated-value");
	});
});

describe("SecretsScanner (proposal-52 AC#1, AC#3)", () => {
	let tempDir: string;
	let scanner: SecretsScanner;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-scan-test-"));
		scanner = new SecretsScanner();
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("AC#1: should detect API keys", () => {
		const content = `const config = { apiKey: "sk-abcdef1234567890" };`;
		const findings = scanner.scanContent(content, "test.ts");

		const apiKeyFinding = findings.find((f: any) => f.type === "api_key");
		assert.ok(apiKeyFinding, "Should detect API key");
		assert.equal(apiKeyFinding?.severity, "high");
	});

	it("AC#3: should detect AWS access keys", () => {
		const content = `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`;
		const findings = scanner.scanContent(content, ".env");

		const awsFinding = findings.find((f: any) => f.type === "aws_access_key");
		assert.ok(awsFinding, "Should detect AWS key");
		assert.equal(awsFinding?.severity, "critical");
	});

	it("should detect private keys", () => {
		const content = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----`;
		const findings = scanner.scanContent(content, "id_rsa");

		const keyFinding = findings.find((f: any) => f.type === "private_key");
		assert.ok(keyFinding, "Should detect private key");
		assert.equal(keyFinding?.severity, "critical");
	});

	it("should detect GitHub tokens", () => {
		const content = `GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`;
		const findings = scanner.scanContent(content, ".env");

		const ghFinding = findings.find((f: any) => f.type === "github_token");
		assert.ok(ghFinding, "Should detect GitHub token");
		assert.equal(ghFinding?.severity, "critical");
	});

	it("should detect bearer tokens", () => {
		const content = `Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`;
		const findings = scanner.scanContent(content, "config.ts");

		const bearerFinding = findings.find((f: any) => f.type === "bearer_token");
		assert.ok(bearerFinding, "Should detect bearer token");
	});

	it("should detect password assignments", () => {
		const content = `const db = { password: "supersecretpassword123" };`;
		const findings = scanner.scanContent(content, "db.ts");

		const passFinding = findings.find(
			(f: any) => f.type === "password_assignment",
		);
		assert.ok(passFinding, "Should detect password");
		assert.equal(passFinding?.severity, "high");
	});

	it("should pass clean content", () => {
		const content = `const config = { apiUrl: "https://api.example.com" };`;
		const findings = scanner.scanContent(content, "config.ts");

		const criticalFindings = findings.filter(
			(f) => f.severity === "critical" || f.severity === "high",
		);
		assert.equal(
			criticalFindings.length,
			0,
			"Clean content should have no high/critical findings",
		);
	});

	it("should scan files correctly", async () => {
		const testFile = join(tempDir, "secret-config.ts");
		await writeFile(
			testFile,
			`export const API_KEY = "sk-test1234567890abcdef";`,
		);

		const result = await scanner.scanFile(testFile);
		assert.equal(result.passed, false, "File with secrets should not pass");
		assert.ok(result.findings.length > 0, "Should have findings");
	});

	it("should scan directories recursively", async () => {
		const subDir = join(tempDir, "src");
		await mkdir(subDir, { recursive: true });
		await writeFile(
			join(subDir, "config.ts"),
			`export const TOKEN = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";`,
		);
		await writeFile(
			join(subDir, "clean.ts"),
			`export const API_URL = "https://api.example.com";`,
		);

		const results = await scanner.scanDirectory(tempDir, [".ts"]);
		const findings = results.flatMap((r) => r.findings);
		assert.ok(
			findings.some((f) => f.type === "github_token"),
			"Should find GitHub token",
		);
	});
});

describe("Pre-commit Hook (proposal-52 AC#3)", () => {
	it("should generate valid pre-commit hook script", () => {
		const hook = generatePreCommitHook();

		assert.ok(hook.includes("#!/usr/bin/env node"), "Should have shebang");
		assert.ok(hook.includes("SecretsScanner"), "Should import scanner");
		assert.ok(hook.includes("git diff --cached"), "Should check staged files");
		assert.ok(
			hook.includes("process.exit(1)"),
			"Should exit with error on violations",
		);
	});
});

describe("Utility Functions", () => {
	it("containsSecrets should detect secrets in content", () => {
		assert.ok(containsSecrets('api_key = "sk-abcdef1234567890"'));
		assert.ok(!containsSecrets('api_url = "https://example.com"'));
	});

	it("maskSecrets should redact found secrets", () => {
		const content = 'API_KEY = "sk-abcdef1234567890"';
		const masked = maskSecrets(content);

		assert.ok(
			!masked.includes("sk-abcdef1234567890"),
			"Original secret should be masked",
		);
		assert.ok(masked.includes("[REDACTED-"), "Should contain redaction marker");
	});
});
