/**
 * STATE-53: Audit Logging & Forensic Trail
 *
 * Immutable, append-only audit log for security-relevant events.
 * Supports incident investigation, compliance reporting, and anomaly detection.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, gzip } from "node:zlib";

export type AuditEventType =
	| "proposal_claim"
	| "proposal_start"
	| "proposal_complete"
	| "proposal_revert"
	| "auth_token_issued"
	| "auth_token_validated"
	| "auth_token_revoked"
	| "auth_failed"
	| "rate_limit_check"
	| "rate_limit_violation"
	| "rate_limit_suspension"
	| "message_sent"
	| "message_received"
	| "message_verification"
	| "anomaly_detected"
	| "agent_suspended"
	| "agent_contained";

export interface AuditEntry {
	id: string;
	timestamp: string;
	eventType: AuditEventType;
	agentId: string;
	targetId?: string; // Proposal ID, token ID, message ID, etc.
	action: string;
	result: "success" | "failure" | "warning";
	details: Record<string, unknown>;
	previousHash: string;
	hash: string;
}

export interface AuditQueryOptions {
	agentId?: string;
	targetId?: string;
	eventType?: AuditEventType;
	startDate?: string;
	endDate?: string;
	result?: "success" | "failure" | "warning";
	limit?: number;
	offset?: number;
}

export interface AuditStats {
	totalEntries: number;
	entriesByType: Record<AuditEventType, number>;
	failureRate: number;
	uniqueAgents: number;
	oldestEntry: string | null;
	newestEntry: string | null;
	hashChainValid: boolean;
}

export interface AnomalyAlert {
	type: "high_volume" | "auth_failures" | "hash_chain_break";
	severity: "warning" | "critical";
	agentId?: string;
	message: string;
	details: Record<string, unknown>;
	detectedAt: string;
}

/**
 * AuditLog - Append-only, hash-chained audit trail
 */
export class AuditLog {
	private readonly logPath: string;
	private readonly archivePath: string;
	private lastHash: string = "genesis";
	private entryCount: number = 0;
	private retentionDays: number = 90;

	// Anomaly detection thresholds
	private readonly thresholds = {
		highVolumeClaims: { count: 100, windowMs: 3600000 }, // 100 claims/hour
		authFailures: { count: 10, windowMs: 300000 }, // 10 failures in 5 minutes
	};

	// In-memory tracking for anomaly detection
	private recentClaims: Map<string, number[]> = new Map(); // agentId -> timestamps
	private recentAuthFailures: Map<string, number[]> = new Map();

	constructor(basePath: string) {
		this.logPath = join(basePath, "roadmap", "audit.log");
		this.archivePath = join(basePath, "roadmap", "archive", "audit");
	}

	/**
	 * Initialize the audit log
	 */
	async initialize(): Promise<void> {
		await mkdir(dirname(this.logPath), { recursive: true });
		await mkdir(this.archivePath, { recursive: true });

		// Load existing log to get last hash
		try {
			await access(this.logPath);
			const content = await readFile(this.logPath, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			if (lines.length > 0) {
				const lastEntry: AuditEntry = JSON.parse(lines[lines.length - 1]);
				this.lastHash = lastEntry.hash;
				this.entryCount = lines.length;
			}
		} catch {
			// File doesn't exist yet - start fresh with genesis hash
			this.lastHash = "genesis";
			this.entryCount = 0;
		}
	}

	/**
	 * Log a proposal transition event
	 */
	async logProposalTransition(
		eventType:
			| "proposal_claim"
			| "proposal_start"
			| "proposal_complete"
			| "proposal_revert",
		agentId: string,
		proposalId: string,
		action: string,
		result: "success" | "failure" | "warning",
		details: Record<string, unknown> = {},
	): Promise<AuditEntry> {
		const entry = await this.createEntry({
			eventType,
			agentId,
			targetId: proposalId,
			action,
			result,
			details: { ...details, proposalId },
		});

		// Track for anomaly detection
		this.trackClaim(agentId);

		return entry;
	}

	/**
	 * Log an authentication event
	 */
	async logAuthEvent(
		eventType:
			| "auth_token_issued"
			| "auth_token_validated"
			| "auth_token_revoked"
			| "auth_failed",
		agentId: string,
		action: string,
		result: "success" | "failure" | "warning",
		details: Record<string, unknown> = {},
	): Promise<AuditEntry> {
		const entry = await this.createEntry({
			eventType,
			agentId,
			action,
			result,
			details,
		});

		// Track failures for anomaly detection
		if (eventType === "auth_failed") {
			this.trackAuthFailure(agentId);
		}

		return entry;
	}

	/**
	 * Log a rate limit event
	 */
	async logRateLimitEvent(
		eventType:
			| "rate_limit_check"
			| "rate_limit_violation"
			| "rate_limit_suspension",
		agentId: string,
		action: string,
		result: "success" | "failure" | "warning",
		details: Record<string, unknown> = {},
	): Promise<AuditEntry> {
		return this.createEntry({
			eventType,
			agentId,
			action,
			result,
			details,
		});
	}

	/**
	 * Log an inter-host message event
	 */
	async logMessageEvent(
		eventType: "message_sent" | "message_received" | "message_verification",
		agentId: string,
		messageId: string,
		action: string,
		result: "success" | "failure" | "warning",
		details: Record<string, unknown> = {},
	): Promise<AuditEntry> {
		return this.createEntry({
			eventType,
			agentId,
			targetId: messageId,
			action,
			result,
			details,
		});
	}

	/**
	 * Log an anomaly detection event
	 */
	async logAnomaly(
		anomalyType: string,
		agentId: string,
		severity: "warning" | "critical",
		details: Record<string, unknown> = {},
	): Promise<AuditEntry> {
		return this.createEntry({
			eventType: "anomaly_detected",
			agentId,
			action: `anomaly_${anomalyType}`,
			result: severity === "critical" ? "failure" : "warning",
			details: { ...details, anomalyType, severity },
		});
	}

	/**
	 * Query audit entries
	 */
	async query(options: AuditQueryOptions = {}): Promise<AuditEntry[]> {
		const results: AuditEntry[] = [];
		let offset = 0;
		let count = 0;
		const limit = options.limit ?? 100;

		try {
			await access(this.logPath);
		} catch {
			return [];
		}

		const fileStream = createReadStream(this.logPath);
		const rl = createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (!line.trim()) continue;

			try {
				const entry: AuditEntry = JSON.parse(line);

				// Apply filters
				if (options.agentId && entry.agentId !== options.agentId) continue;
				if (options.targetId && entry.targetId !== options.targetId) continue;
				if (options.eventType && entry.eventType !== options.eventType)
					continue;
				if (options.result && entry.result !== options.result) continue;

				if (options.startDate && entry.timestamp < options.startDate) continue;
				if (options.endDate && entry.timestamp > options.endDate) continue;

				if (offset < (options.offset ?? 0)) {
					offset++;
					continue;
				}

				results.push(entry);
				count++;
				if (count >= limit) break;
			} catch {
				// Skip malformed lines
			}
		}

		return results;
	}

	/**
	 * Get audit statistics
	 */
	async getStats(): Promise<AuditStats> {
		const stats: AuditStats = {
			totalEntries: 0,
			entriesByType: {} as Record<AuditEventType, number>,
			failureRate: 0,
			uniqueAgents: 0,
			oldestEntry: null,
			newestEntry: null,
			hashChainValid: true,
		};

		const agents = new Set<string>();
		let failures = 0;
		let lastHash = "genesis";
		let firstEntry = true;

		try {
			await access(this.logPath);
		} catch {
			return stats;
		}

		const fileStream = createReadStream(this.logPath);
		const rl = createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (!line.trim()) continue;

			try {
				const entry: AuditEntry = JSON.parse(line);
				stats.totalEntries++;
				agents.add(entry.agentId);

				if (entry.result === "failure") failures++;

				stats.entriesByType[entry.eventType] =
					(stats.entriesByType[entry.eventType] || 0) + 1;

				if (firstEntry) {
					stats.oldestEntry = entry.timestamp;
					firstEntry = false;
				}
				stats.newestEntry = entry.timestamp;

				// Verify hash chain (skip genesis)
				if (
					entry.previousHash !== lastHash &&
					entry.previousHash !== "genesis"
				) {
					stats.hashChainValid = false;
				}
				lastHash = entry.hash;
			} catch {
				// Skip malformed lines
			}
		}

		stats.failureRate =
			stats.totalEntries > 0 ? failures / stats.totalEntries : 0;
		stats.uniqueAgents = agents.size;

		return stats;
	}

	/**
	 * Validate the hash chain integrity
	 */
	async validateHashChain(): Promise<{
		valid: boolean;
		brokenAt?: number;
		entries: number;
	}> {
		let previousHash = "genesis";
		let index = 0;

		try {
			await access(this.logPath);
		} catch {
			return { valid: true, entries: 0 };
		}

		const fileStream = createReadStream(this.logPath);
		const rl = createInterface({
			input: fileStream,
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			if (!line.trim()) continue;
			index++;

			try {
				const entry: AuditEntry = JSON.parse(line);

				if (entry.previousHash !== previousHash) {
					return { valid: false, brokenAt: index, entries: index };
				}

				// Verify entry hash
				const computedHash = this.computeHash(entry, previousHash);
				if (entry.hash !== computedHash) {
					return { valid: false, brokenAt: index, entries: index };
				}

				previousHash = entry.hash;
			} catch {
				return { valid: false, brokenAt: index, entries: index };
			}
		}

		return { valid: true, entries: index };
	}

	/**
	 * Check for anomalies and return alerts
	 */
	checkAnomalies(): AnomalyAlert[] {
		const alerts: AnomalyAlert[] = [];
		const now = Date.now();

		// Check high volume claims
		for (const [agentId, timestamps] of this.recentClaims) {
			const windowStart = now - this.thresholds.highVolumeClaims.windowMs;
			const recentCount = timestamps.filter((t) => t > windowStart).length;

			if (recentCount >= this.thresholds.highVolumeClaims.count) {
				alerts.push({
					type: "high_volume",
					severity: "critical",
					agentId,
					message: `Agent ${agentId} claimed ${recentCount} proposals in the last hour`,
					details: {
						count: recentCount,
						windowMs: this.thresholds.highVolumeClaims.windowMs,
						threshold: this.thresholds.highVolumeClaims.count,
					},
					detectedAt: new Date().toISOString(),
				});

				// Clean up to avoid repeated alerts
				this.recentClaims.delete(agentId);
			}
		}

		// Check auth failures
		for (const [agentId, timestamps] of this.recentAuthFailures) {
			const windowStart = now - this.thresholds.authFailures.windowMs;
			const recentCount = timestamps.filter((t) => t > windowStart).length;

			if (recentCount >= this.thresholds.authFailures.count) {
				alerts.push({
					type: "auth_failures",
					severity: "critical",
					agentId,
					message: `Agent ${agentId} had ${recentCount} authentication failures in 5 minutes`,
					details: {
						count: recentCount,
						windowMs: this.thresholds.authFailures.windowMs,
						threshold: this.thresholds.authFailures.count,
					},
					detectedAt: new Date().toISOString(),
				});

				this.recentAuthFailures.delete(agentId);
			}
		}

		return alerts;
	}

	/**
	 * Archive old log entries
	 */
	async archiveOldEntries(retentionDays?: number): Promise<number> {
		const days = retentionDays ?? this.retentionDays;
		const cutoff = new Date(
			Date.now() - days * 24 * 60 * 60 * 1000,
		).toISOString();
		const entriesToArchive: AuditEntry[] = [];
		const entriesToKeep: AuditEntry[] = [];

		try {
			await access(this.logPath);
		} catch {
			return 0;
		}

		const content = await readFile(this.logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const entry: AuditEntry = JSON.parse(line);
				if (entry.timestamp < cutoff) {
					entriesToArchive.push(entry);
				} else {
					entriesToKeep.push(entry);
				}
			} catch {
				// Keep malformed lines
				entriesToKeep.push(line as unknown as AuditEntry);
			}
		}

		if (entriesToArchive.length === 0) return 0;

		// Write archived entries to compressed file
		const archiveFileName = `audit-${cutoff.split("T")[0]}.log.gz`;
		const archiveFilePath = join(this.archivePath, archiveFileName);
		const archiveContent = `${entriesToArchive
			.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
			.join("\n")}\n`;

		const compressed = await new Promise<Buffer>((resolve, reject) => {
			gzip(Buffer.from(archiveContent), (err, result) => {
				if (err) reject(err);
				else resolve(result);
			});
		});

		await mkdir(this.archivePath, { recursive: true });
		await appendFile(archiveFilePath, compressed);

		// Rewrite main log with only recent entries
		const { writeFile } = await import("node:fs/promises");
		const newContent = `${entriesToKeep
			.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
			.join("\n")}\n`;
		await writeFile(this.logPath, newContent);

		return entriesToArchive.length;
	}

	/**
	 * Query archived logs (returns decompressed content)
	 */
	async queryArchive(archiveFile: string): Promise<AuditEntry[]> {
		const archivePath = join(this.archivePath, archiveFile);

		try {
			const compressed = await readFile(archivePath);
			const decompressed = await new Promise<Buffer>((resolve, reject) => {
				createGunzip().on("data", resolve).on("error", reject).end(compressed);
			});

			return decompressed
				.toString("utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line) as AuditEntry;
					} catch {
						return null;
					}
				})
				.filter((entry): entry is AuditEntry => entry !== null);
		} catch {
			return [];
		}
	}

	/**
	 * Get the total entry count
	 */
	getEntryCount(): number {
		return this.entryCount;
	}

	/**
	 * Get the last hash for chaining
	 */
	getLastHash(): string {
		return this.lastHash;
	}

	/**
	 * Close the audit log (cleanup)
	 */
	close(): void {
		this.recentClaims.clear();
		this.recentAuthFailures.clear();
	}

	// Private methods

	private async createEntry(params: {
		eventType: AuditEventType;
		agentId: string;
		targetId?: string;
		action: string;
		result: "success" | "failure" | "warning";
		details: Record<string, unknown>;
	}): Promise<AuditEntry> {
		const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const timestamp = new Date().toISOString();

		const entry: Omit<AuditEntry, "hash"> = {
			id,
			timestamp,
			eventType: params.eventType,
			agentId: params.agentId,
			targetId: params.targetId,
			action: params.action,
			result: params.result,
			details: params.details,
			previousHash: this.lastHash,
		};

		const hash = this.computeHash(entry, this.lastHash);
		const fullEntry: AuditEntry = { ...entry, hash };

		// Append to log file
		await appendFile(this.logPath, `${JSON.stringify(fullEntry)}\n`);

		this.lastHash = hash;
		this.entryCount++;

		return fullEntry;
	}

	private computeHash(
		entry: Omit<AuditEntry, "hash">,
		previousHash: string,
	): string {
		const data = JSON.stringify({
			id: entry.id,
			timestamp: entry.timestamp,
			eventType: entry.eventType,
			agentId: entry.agentId,
			targetId: entry.targetId,
			action: entry.action,
			result: entry.result,
			details: entry.details,
			previousHash,
		});

		return createHash("sha256").update(data).digest("hex");
	}

	private trackClaim(agentId: string): void {
		const now = Date.now();
		const existing = this.recentClaims.get(agentId) || [];
		// Keep only entries within the last hour
		const windowStart = now - this.thresholds.highVolumeClaims.windowMs;
		const filtered = existing.filter((t) => t > windowStart);
		filtered.push(now);
		this.recentClaims.set(agentId, filtered);
	}

	private trackAuthFailure(agentId: string): void {
		const now = Date.now();
		const existing = this.recentAuthFailures.get(agentId) || [];
		// Keep only entries within the last 5 minutes
		const windowStart = now - this.thresholds.authFailures.windowMs;
		const filtered = existing.filter((t) => t > windowStart);
		filtered.push(now);
		this.recentAuthFailures.set(agentId, filtered);
	}
}
