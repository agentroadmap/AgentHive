/**
 * STATE-52: Secrets Management & Scanning
 *
 * Provides:
 * - AC#1: Secrets scanning before proposal file writes
 * - AC#2: Encrypted vault for API keys
 * - AC#3: Pre-commit hook scanning
 * - AC#4: Key rotation with zero downtime
 */

import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

// ===== TYPES =====

export interface SecretEntry {
	id: string;
	key: string;
	encryptedValue: string;
	iv: string;
	tag: string;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	rotationCount: number;
	metadata?: Record<string, string>;
}

export interface VaultConfig {
	vaultPath: string;
	masterKeyPath: string;
	rotationIntervalMs?: number; // Auto-rotation interval
	maxSecretAge?: number; // Max age before forced rotation
}

export interface ScanResult {
	file: string;
	matches: SecretMatch[];
	clean: boolean;
	scanTime: number;
}

export interface SecretMatch {
	pattern: string;
	line: number;
	column: number;
	snippet: string;
	severity: "low" | "medium" | "high" | "critical";
}

export interface RotationEvent {
	secretId: string;
	oldKeyId: string;
	newKeyId: string;
	rotatedAt: number;
	success: boolean;
	error?: string;
}

// ===== SECRET PATTERNS =====

export const SECRET_PATTERNS: Array<{
	pattern: RegExp;
	name: string;
	severity: SecretMatch["severity"];
}> = [
	// API Keys
	{
		pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([a-zA-Z0-9_-]{16,})['"]/gi,
		name: "API_KEY",
		severity: "high",
	},
	{
		pattern:
			/(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]([a-zA-Z0-9_-]{16,})['"]/gi,
		name: "SECRET_KEY",
		severity: "critical",
	},

	// Tokens
	{
		pattern:
			/(?:token|access[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-.]{20,})['"]/gi,
		name: "TOKEN",
		severity: "high",
	},
	{
		pattern: /(?:bearer)\s+([a-zA-Z0-9_\-.]{20,})/gi,
		name: "BEARER_TOKEN",
		severity: "high",
	},
	{
		pattern: /(?:jwt)\s*[:=]\s*['"]([a-zA-Z0-9_\-.]{20,})['"]/gi,
		name: "JWT",
		severity: "high",
	},

	// Private Keys
	{
		pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
		name: "PRIVATE_KEY",
		severity: "critical",
	},
	{
		pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
		name: "SSH_PRIVATE_KEY",
		severity: "critical",
	},

	// Passwords
	{
		pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{4,})['"]/gi,
		name: "PASSWORD",
		severity: "high",
	},

	// AWS
	{
		pattern: /(?:AKIA[0-9A-Z]{16})/g,
		name: "AWS_ACCESS_KEY",
		severity: "critical",
	},
	{
		pattern:
			/(?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*['"]([a-zA-Z0-9/+=]{40})['"]/gi,
		name: "AWS_SECRET_KEY",
		severity: "critical",
	},

	// GitLab/GitHub
	{
		pattern: /glpat-[a-zA-Z0-9\-_]{20,}/g,
		name: "GITLAB_TOKEN",
		severity: "critical",
	},
	{
		pattern: /gh[pousr]_[a-zA-Z0-9_]{36,}/g,
		name: "GITHUB_TOKEN",
		severity: "critical",
	},

	// Database URLs
	{
		pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:([^@]+)@/gi,
		name: "DATABASE_URL",
		severity: "critical",
	},

	// Generic secrets (lower confidence)
	{
		pattern: /(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}/g,
		name: "STRIPE_KEY",
		severity: "critical",
	},
];

// ===== ENCRYPTED VAULT =====

export class EncryptedVault extends EventEmitter {
	private secrets: Map<string, SecretEntry> = new Map();
	private masterKey: Buffer;
	private vaultPath: string;
	private masterKeyPath: string;
	private rotationTimers: Map<string, NodeJS.Timeout> = new Map();

	constructor(config: VaultConfig) {
		super();
		this.vaultPath = config.vaultPath;
		this.masterKeyPath = config.masterKeyPath;
		this.masterKey = this.loadOrCreateMasterKey();
		this.load();
	}

	private loadOrCreateMasterKey(): Buffer {
		try {
			if (fs.existsSync(this.masterKeyPath)) {
				const keyData = fs.readFileSync(this.masterKeyPath);
				// Verify it's a valid key (32 bytes for AES-256)
				if (keyData.length === 32) {
					return keyData;
				}
			}
		} catch {
			// Fall through to create new key
		}

		// Generate new master key
		const newKey = crypto.randomBytes(32);
		fs.writeFileSync(this.masterKeyPath, newKey, { mode: 0o600 });
		return newKey;
	}

	private load(): void {
		try {
			if (fs.existsSync(this.vaultPath)) {
				const data = JSON.parse(fs.readFileSync(this.vaultPath, "utf-8"));
				this.secrets = new Map(Object.entries(data.secrets || {}));
			}
		} catch {
			this.secrets = new Map();
		}
	}

	private save(): void {
		const data = {
			version: 1,
			updatedAt: Date.now(),
			secrets: Object.fromEntries(this.secrets),
		};
		// Atomic write using temp file + rename
		const tmpPath = `${this.vaultPath}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
		fs.renameSync(tmpPath, this.vaultPath);
	}

	encrypt(value: string): { encryptedValue: string; iv: string; tag: string } {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);

		let encrypted = cipher.update(value, "utf8", "hex");
		encrypted += cipher.final("hex");
		const tag = cipher.getAuthTag();

		return {
			encryptedValue: encrypted,
			iv: iv.toString("hex"),
			tag: tag.toString("hex"),
		};
	}

	decrypt(encryptedValue: string, iv: string, tag: string): string {
		const decipher = crypto.createDecipheriv(
			"aes-256-gcm",
			this.masterKey,
			Buffer.from(iv, "hex"),
		);
		decipher.setAuthTag(Buffer.from(tag, "hex"));

		let decrypted = decipher.update(encryptedValue, "hex", "utf8");
		decrypted += decipher.final("utf8");
		return decrypted;
	}

	/**
	 * AC#2: Store a secret in the encrypted vault
	 */
	store(
		key: string,
		value: string,
		metadata?: Record<string, string>,
	): SecretEntry {
		const { encryptedValue, iv, tag } = this.encrypt(value);
		const now = Date.now();

		const existing = this.secrets.get(key);
		const entry: SecretEntry = {
			id: existing?.id || crypto.randomUUID(),
			key,
			encryptedValue,
			iv,
			tag,
			createdAt: existing?.createdAt || now,
			updatedAt: now,
			rotationCount: existing ? existing.rotationCount + 1 : 0,
			metadata,
		};

		this.secrets.set(key, entry);
		this.save();

		this.emit("secret:stored", { key, rotationCount: entry.rotationCount });
		return entry;
	}

	/**
	 * Retrieve and decrypt a secret
	 */
	retrieve(key: string): string | null {
		const entry = this.secrets.get(key);
		if (!entry) return null;

		// Check if expired
		if (entry.expiresAt && Date.now() > entry.expiresAt) {
			this.emit("secret:expired", { key });
			return null;
		}

		return this.decrypt(entry.encryptedValue, entry.iv, entry.tag);
	}

	/**
	 * AC#4: Rotate a secret's encryption (zero downtime)
	 */
	rotate(key: string, newValue: string): SecretEntry {
		const oldEntry = this.secrets.get(key);

		// Create new encryption with fresh IV
		const { encryptedValue, iv, tag } = this.encrypt(newValue);
		const now = Date.now();

		const newEntry: SecretEntry = {
			id: oldEntry?.id || crypto.randomUUID(),
			key,
			encryptedValue,
			iv,
			tag,
			createdAt: oldEntry?.createdAt || now,
			updatedAt: now,
			rotationCount: (oldEntry?.rotationCount || 0) + 1,
			metadata: oldEntry?.metadata,
		};

		this.secrets.set(key, newEntry);
		this.save();

		const event: RotationEvent = {
			secretId: newEntry.id,
			oldKeyId: oldEntry?.id || "none",
			newKeyId: newEntry.id,
			rotatedAt: now,
			success: true,
		};

		this.emit("secret:rotated", event);
		return newEntry;
	}

	/**
	 * Delete a secret
	 */
	delete(key: string): boolean {
		const deleted = this.secrets.delete(key);
		if (deleted) {
			this.save();
			this.emit("secret:deleted", { key });
		}
		return deleted;
	}

	/**
	 * List all secret keys (not values)
	 */
	listKeys(): string[] {
		return Array.from(this.secrets.keys());
	}

	/**
	 * Check if a key exists
	 */
	has(key: string): boolean {
		return this.secrets.has(key);
	}

	/**
	 * Get metadata for a secret without decrypting
	 */
	getMetadata(
		key: string,
	): Omit<SecretEntry, "encryptedValue" | "iv" | "tag"> | null {
		const entry = this.secrets.get(key);
		if (!entry) return null;

		return {
			id: entry.id,
			key: entry.key,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			expiresAt: entry.expiresAt,
			rotationCount: entry.rotationCount,
			metadata: entry.metadata,
		};
	}

	/**
	 * Schedule auto-rotation for a secret
	 */
	scheduleRotation(
		key: string,
		intervalMs: number,
		rotateFn: () => Promise<string>,
	): void {
		// Clear existing timer if any
		const existingTimer = this.rotationTimers.get(key);
		if (existingTimer) {
			clearInterval(existingTimer);
		}

		const timer = setInterval(async () => {
			try {
				const newValue = await rotateFn();
				this.rotate(key, newValue);
			} catch (err) {
				this.emit("rotation:error", { key, error: err });
			}
		}, intervalMs);

		this.rotationTimers.set(key, timer);
	}

	/**
	 * Clear all rotation timers
	 */
	clearScheduledRotations(): void {
		for (const timer of this.rotationTimers.values()) {
			clearInterval(timer);
		}
		this.rotationTimers.clear();
	}

	/**
	 * Securely wipe vault from memory
	 */
	destroy(): void {
		this.clearScheduledRotations();
		this.masterKey.fill(0);
		this.secrets.clear();
	}
}

// ===== SECRETS SCANNER =====

export class SecretsScanner {
	private customPatterns: Array<{
		pattern: RegExp;
		name: string;
		severity: SecretMatch["severity"];
	}>;
	private ignorePatterns: RegExp[];
	private scanCache: Map<string, ScanResult> = new Map();

	constructor(options?: {
		customPatterns?: Array<{
			pattern: RegExp;
			name: string;
			severity: SecretMatch["severity"];
		}>;
		ignorePatterns?: RegExp[];
	}) {
		this.customPatterns = options?.customPatterns || [];
		this.ignorePatterns = options?.ignorePatterns || [];
	}

	/**
	 * AC#1: Scan content for secrets
	 */
	scanContent(content: string, filename: string): ScanResult {
		const startTime = Date.now();
		const allPatterns = [...SECRET_PATTERNS, ...this.customPatterns];
		const matches: SecretMatch[] = [];

		const lines = content.split("\n");

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum];

			// Skip lines matching ignore patterns
			if (this.ignorePatterns.some((p) => p.test(line))) {
				continue;
			}

			for (const { pattern, name, severity } of allPatterns) {
				pattern.lastIndex = 0; // Reset regex proposal
				let match: RegExpExecArray | null;

				match = pattern.exec(line);
				while (match !== null) {
					matches.push({
						pattern: name,
						line: lineNum + 1,
						column: match.index,
						snippet:
							line.trim().substring(0, 50) + (line.length > 50 ? "..." : ""),
						severity,
					});
					match = pattern.exec(line);
				}
			}
		}

		const result: ScanResult = {
			file: filename,
			matches,
			clean: matches.length === 0,
			scanTime: Date.now() - startTime,
		};

		this.scanCache.set(`${filename}:${content.length}`, result);
		return result;
	}

	/**
	 * Scan a file for secrets
	 */
	scanFile(filePath: string): ScanResult {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			return this.scanContent(content, filePath);
		} catch (err) {
			return {
				file: filePath,
				matches: [
					{
						pattern: "FILE_READ_ERROR",
						line: 0,
						column: 0,
						snippet: `Could not read file: ${err}`,
						severity: "low",
					},
				],
				clean: false,
				scanTime: 0,
			};
		}
	}

	/**
	 * Scan multiple files
	 */
	scanFiles(filePaths: string[]): ScanResult[] {
		return filePaths.map((fp) => this.scanFile(fp));
	}

	/**
	 * Scan a directory recursively
	 */
	scanDirectory(dirPath: string, extensions?: string[]): ScanResult[] {
		const results: ScanResult[] = [];

		const scan = (dir: string) => {
			const entries = fs.readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				// Skip common non-scan directories
				if (
					entry.isDirectory() &&
					!["node_modules", ".git", "dist", "coverage"].includes(entry.name)
				) {
					scan(fullPath);
				} else if (entry.isFile()) {
					if (
						!extensions ||
						extensions.some((ext) => entry.name.endsWith(ext))
					) {
						results.push(this.scanFile(fullPath));
					}
				}
			}
		};

		scan(dirPath);
		return results;
	}

	/**
	 * Clear scan cache
	 */
	clearCache(): void {
		this.scanCache.clear();
	}
}

// ===== PRE-COMMIT HOOK GENERATOR =====

/**
 * AC#3: Generate pre-commit hook script
 */
export function generatePreCommitHook(options?: {
	scannerConfig?: {
		customPatterns?: Array<{
			pattern: RegExp;
			name: string;
			severity: SecretMatch["severity"];
		}>;
		ignorePatterns?: RegExp[];
	};
	failOnSeverity?: SecretMatch["severity"];
	excludePatterns?: string[];
}): string {
	const failOn = options?.failOnSeverity || "high";
	const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
	const minSeverity = severityOrder[failOn];

	const script = `#!/bin/bash
# STATE-52: Pre-commit hook for secrets scanning
# Auto-generated by Carter SecretsScanner

set -e

echo "🔍 Scanning for secrets..."

# Files staged for commit
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Run scanner via Node.js
SCAN_RESULT=$(node -e "
const { SecretsScanner } = require('./src/core/secrets-manager');
const fs = require('fs');

const scanner = new SecretsScanner();
const files = process.argv.slice(1);
const results = scanner.scanFiles(files);
const issues = results.filter(r => !r.clean);

const severityOrder = { low: 0, medium: 1, high: 2, critical: 3 };
const minSeverity = ${minSeverity};

const criticalIssues = issues.flatMap(r => 
  r.matches.filter(m => severityOrder[m.severity] >= minSeverity)
);

if (criticalIssues.length > 0) {
  console.log('SECRETS_FOUND');
  issues.forEach(r => {
    if (!r.clean) {
      r.matches.forEach(m => {
        if (severityOrder[m.severity] >= minSeverity) {
          console.log(\`  [\${m.severity.toUpperCase()}] \${r.file}:\${m.line} - \${m.pattern}\`);
          console.log(\`    \${m.snippet}\`);
        }
      });
    }
  });
} else {
  console.log('CLEAN');
}
" $STAGED_FILES)

if echo "$SCAN_RESULT" | grep -q "SECRETS_FOUND"; then
  echo ""
  echo "❌ Secrets detected in staged files!"
  echo ""
  echo "$SCAN_RESULT"
  echo ""
  echo "Please remove secrets before committing."
  echo "Use 'git reset HEAD <file>' to unstage, or add to .secretsignore"
  exit 1
fi

echo "✅ No secrets detected."
exit 0
`;

	return script;
}

// ===== MAIN EXPORTS =====

// Re-export for convenience
export type { SecretEntry as Secret };
