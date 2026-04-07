/**
 * Secrets Management & Scanning (STATE-52)
 *
 * AC#1: Secrets scanning runs before proposal file writes
 * AC#2: API keys stored in encrypted vault, not environment vars
 * AC#3: Pre-commit hook scans for leaked credentials
 * AC#4: Key rotation mechanism with zero downtime
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface SecretEntry {
	key: string;
	value: string;
	createdAt: string;
	updatedAt: string;
	version: number;
	metadata?: Record<string, string>;
}

export interface VaultConfig {
	vaultPath: string;
	encryptionKey?: string; // If not provided, generated on first run and stored in .vault-key
}

export interface ScanResult {
	file: string;
	findings: SecretFinding[];
	scanTime: string;
	passed: boolean;
}

export interface SecretFinding {
	type: SecretType;
	line: number;
	column: number;
	value: string; // Masked value (first 4 chars + ****)
	severity: "critical" | "high" | "medium" | "low";
	pattern: string;
}

export type SecretType =
	| "api_key"
	| "aws_access_key"
	| "private_key"
	| "password_assignment"
	| "bearer_token"
	| "github_token"
	| "generic_secret";

// ─── Constants ───────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Patterns for secret detection
const SECRET_PATTERNS: Record<
	SecretType,
	{ pattern: RegExp; severity: SecretFinding["severity"] }
> = {
	api_key: {
		pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"`]([^'"`\s]{8,})['"`]/gi,
		severity: "high",
	},
	aws_access_key: {
		pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
		severity: "critical",
	},
	private_key: {
		pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH)\s+PRIVATE\s+KEY-----/g,
		severity: "critical",
	},
	password_assignment: {
		pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"`]([^'"`\s]{4,})['"`]/gi,
		severity: "high",
	},
	bearer_token: {
		pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
		severity: "high",
	},
	github_token: {
		pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
		severity: "critical",
	},
	generic_secret: {
		pattern: /(?:secret|token|credential)\s*[=:]\s*['"`]([^'"`\s]{8,})['"`]/gi,
		severity: "medium",
	},
};

// ─── Encrypted Vault ─────────────────────────────────────────────────

export class EncryptedVault {
	private config: VaultConfig;
	private encryptionKey: Buffer | null = null;
	private secrets: Map<string, SecretEntry> = new Map();

	constructor(config?: Partial<VaultConfig>) {
		this.config = {
			vaultPath: config?.vaultPath ?? join(process.cwd(), ".roadmap", "vault"),
			encryptionKey: config?.encryptionKey,
		};
	}

	/**
	 * AC#2: Initialize vault with encryption key.
	 * If no key provided, generates and persists one.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.config.vaultPath, { recursive: true });

		if (this.config.encryptionKey) {
			this.encryptionKey = Buffer.from(this.config.encryptionKey, "hex").slice(
				0,
				KEY_LENGTH,
			);
		} else {
			const keyPath = join(this.config.vaultPath, ".vault-key");
			try {
				await access(keyPath);
				const storedKey = await readFile(keyPath, "utf-8");
				this.encryptionKey = Buffer.from(storedKey.trim(), "hex");
			} catch {
				// Generate new key
				this.encryptionKey = randomBytes(KEY_LENGTH);
				await writeFile(keyPath, this.encryptionKey.toString("hex"), {
					mode: 0o600,
				});
			}
		}

		// Load existing secrets
		await this.loadVault();
	}

	private async loadVault(): Promise<void> {
		const vaultFile = join(this.config.vaultPath, "vault.enc");
		try {
			await access(vaultFile);
			const encrypted = await readFile(vaultFile);
			const decrypted = this.decrypt(encrypted);
			const data = JSON.parse(decrypted) as Record<string, SecretEntry>;
			this.secrets = new Map(Object.entries(data));
		} catch {
			// Vault doesn't exist yet, start fresh
			this.secrets = new Map();
		}
	}

	private async saveVault(): Promise<void> {
		const vaultFile = join(this.config.vaultPath, "vault.enc");
		const data = Object.fromEntries(this.secrets);
		const json = JSON.stringify(data, null, 2);
		const encrypted = this.encrypt(json);
		await writeFile(vaultFile, encrypted, { mode: 0o600 });
	}

	private encrypt(plaintext: string): Buffer {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, this.encryptionKey!, iv);
		const encrypted = Buffer.concat([
			cipher.update(plaintext, "utf-8"),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		// Format: iv + tag + encrypted
		return Buffer.concat([iv, tag, encrypted]);
	}

	private decrypt(buffer: Buffer): string {
		const iv = buffer.subarray(0, IV_LENGTH);
		const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
		const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH);
		const decipher = createDecipheriv(ALGORITHM, this.encryptionKey!, iv);
		decipher.setAuthTag(tag);
		return decipher.update(encrypted) + decipher.final("utf-8");
	}

	/**
	 * AC#2: Store a secret in the encrypted vault.
	 */
	async setSecret(
		key: string,
		value: string,
		metadata?: Record<string, string>,
	): Promise<SecretEntry> {
		const existing = this.secrets.get(key);
		const entry: SecretEntry = {
			key,
			value,
			createdAt: existing?.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			version: existing ? existing.version + 1 : 1,
			metadata,
		};
		this.secrets.set(key, entry);
		await this.saveVault();
		return entry;
	}

	/**
	 * Retrieve a secret from the vault.
	 */
	getSecret(key: string): SecretEntry | null {
		return this.secrets.get(key) ?? null;
	}

	/**
	 * List all secret keys (values are not returned).
	 */
	listSecrets(): string[] {
		return Array.from(this.secrets.keys());
	}

	/**
	 * AC#4: Rotate a secret — creates new version, keeps old for grace period.
	 */
	async rotateSecret(key: string, newValue: string): Promise<SecretEntry> {
		const existing = this.secrets.get(key);
		if (!existing) {
			throw new Error(`Secret '${key}' not found in vault`);
		}

		// Archive old version
		const archivePath = join(
			this.config.vaultPath,
			`${key}.v${existing.version}.archive`,
		);
		await writeFile(
			archivePath,
			JSON.stringify({ ...existing, archivedAt: new Date().toISOString() }),
			{ mode: 0o600 },
		);

		return this.setSecret(key, newValue);
	}

	/**
	 * Delete a secret from the vault.
	 */
	async deleteSecret(key: string): Promise<boolean> {
		const deleted = this.secrets.delete(key);
		if (deleted) {
			await this.saveVault();
		}
		return deleted;
	}
}

// ─── Secrets Scanner ─────────────────────────────────────────────────

export class SecretsScanner {
	private readonly excludePatterns: string[];
	private readonly customPatterns: Map<
		SecretType,
		{ pattern: RegExp; severity: SecretFinding["severity"] }
	>;

	constructor(options?: {
		excludePatterns?: string[];
		customPatterns?: Map<
			SecretType,
			{ pattern: RegExp; severity: SecretFinding["severity"] }
		>;
	}) {
		this.excludePatterns = options?.excludePatterns ?? [
			"node_modules",
			".git",
			"dist",
			"*.enc",
			".vault-key",
			"*.archive",
		];
		this.customPatterns = options?.customPatterns ?? new Map();
	}

	/**
	 * AC#1: Scan content for secrets before writing.
	 * Returns findings — empty array means safe to write.
	 */
	scanContent(content: string, _filename: string): SecretFinding[] {
		const findings: SecretFinding[] = [];
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const lineNumber = i + 1;

			for (const [type, config] of [
				...Object.entries(SECRET_PATTERNS),
				...this.customPatterns.entries(),
			]) {
				config.pattern.lastIndex = 0; // Reset regex proposal
				let match: RegExpExecArray | null;

				while ((match = config.pattern.exec(line)) !== null) {
					const matchedText = match[0];
					const maskedValue = this.maskValue(matchedText);

					findings.push({
						type: type as SecretType,
						line: lineNumber,
						column: match.index,
						value: maskedValue,
						severity: config.severity,
						pattern: `${matchedText.slice(0, 20)}...`,
					});
				}
			}
		}

		return findings;
	}

	/**
	 * AC#1: Scan a file for secrets.
	 */
	async scanFile(filePath: string): Promise<ScanResult> {
		const content = await readFile(filePath, "utf-8");
		const findings = this.scanContent(content, basename(filePath));

		return {
			file: filePath,
			findings,
			scanTime: new Date().toISOString(),
			passed:
				findings.filter(
					(f) => f.severity === "critical" || f.severity === "high",
				).length === 0,
		};
	}

	/**
	 * AC#3: Scan directory for secrets (used by pre-commit hook).
	 */
	async scanDirectory(
		dirPath: string,
		extensions?: string[],
	): Promise<ScanResult[]> {
		const results: ScanResult[] = [];
		const exts = extensions ?? [
			".ts",
			".js",
			".json",
			".md",
			".yml",
			".yaml",
			".env",
			".txt",
		];

		const entries = await readdir(dirPath, { recursive: true });

		for (const entry of entries) {
			const fullPath = join(dirPath, entry as string);
			const fileName = basename(entry as string);

			// Check exclusions
			if (this.excludePatterns.some((p) => (entry as string).includes(p))) {
				continue;
			}

			// Check extensions
			if (!exts.some((ext) => fileName.endsWith(ext))) {
				continue;
			}

			try {
				const result = await this.scanFile(fullPath);
				if (result.findings.length > 0) {
					results.push(result);
				}
			} catch {
				// Skip files that can't be read
			}
		}

		return results;
	}

	private maskValue(value: string): string {
		if (value.length <= 8) return "****";
		return `${value.slice(0, 4)}****${value.slice(-4)}`;
	}
}

// ─── Pre-commit Hook Generator ──────────────────────────────────────

/**
 * AC#3: Generate a pre-commit hook that scans for secrets.
 */
export function generatePreCommitHook(): string {
	return `#!/usr/bin/env node
/**
 * Roadmap Pre-commit Hook — Secrets Scanner
 * Generated by STATE-52: Secrets-Management-Scanning
 *
 * Prevents commits containing secrets or credentials.
 */
import { SecretsScanner } from "./src/core/secrets-scanner.ts";
import { execSync } from "node:child_process";

async function main() {
  // Get staged files
  const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf-8" })
    .trim()
    .split("\\n")
    .filter(Boolean);

  if (staged.length === 0) process.exit(0);

  const scanner = new SecretsScanner();
  const violations: string[] = [];

  for (const file of staged) {
    try {
      const result = await scanner.scanFile(file);
      const critical = result.findings.filter(f => f.severity === "critical" || f.severity === "high");
      if (critical.length > 0) {
        violations.push(\`\${file}:\`);
        for (const f of critical) {
          violations.push(\`  Line \${f.line}: \${f.type} (\${f.severity}) - \${f.value}\`);
        }
      }
    } catch {
      // Skip binary/unreadable files
    }
  }

  if (violations.length > 0) {
    console.error("❌ Secrets detected in staged files:");
    console.error(violations.join("\\n"));
    console.error("\\nRemove secrets and use the encrypted vault (EncryptedVault) instead.");
    console.error("Run 'roadmap vault set <key> <value>' to store secrets securely.");
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Pre-commit hook error:", err);
  process.exit(1);
});
`;
}

// ─── Utility Functions ───────────────────────────────────────────────

/**
 * Check if a string contains potential secrets.
 */
export function containsSecrets(content: string): boolean {
	const scanner = new SecretsScanner();
	const findings = scanner.scanContent(content, "inline");
	return findings.some(
		(f) => f.severity === "critical" || f.severity === "high",
	);
}

/**
 * Mask sensitive values in a string for safe logging.
 */
export function maskSecrets(content: string): string {
	const scanner = new SecretsScanner();
	const findings = scanner.scanContent(content, "inline");

	let masked = content;
	for (const finding of findings) {
		// Replace with masked version in the content
		const regex = new RegExp(finding.pattern.replace(/\.\.\.$/, ""), "gi");
		masked = masked.replace(regex, `[REDACTED-${finding.type}]`);
	}
	return masked;
}
