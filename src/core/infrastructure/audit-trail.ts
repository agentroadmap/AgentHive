/**
 * Audit Logging & Forensic Trail (STATE-53)
 *
 * AC#1: All proposal transitions logged with timestamp and actor
 * AC#2: Authentication events logged (success and failure)
 * AC#3: Rate limit violations recorded with agent ID
 * AC#4: Audit logs queryable via MCP tool
 * AC#5: Logs retained for configurable period (default 90 days)
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type AuditEventType =
	| "proposal_transition"
	| "auth_success"
	| "auth_failure"
	| "rate_limit_violation"
	| "token_issued"
	| "token_verify"
	| "key_rotation"
	| "secret_access"
	| "message_sent"
	| "message_received"
	| "agent_registered"
	| "agent_deregistered"
	| "config_change"
	| "error";

export interface AuditEvent {
	id: string;
	timestamp: string;
	type: AuditEventType;
	agentId: string;
	action: string;
	resource?: string;
	resourceId?: string;
	success: boolean;
	details?: Record<string, unknown>;
	sourceIp?: string;
	sessionId?: string;
	correlationId?: string;
}

export interface AuditQuery {
	eventType?: AuditEventType;
	agentId?: string;
	startTime?: string;
	endTime?: string;
	resource?: string;
	success?: boolean;
	limit?: number;
	offset?: number;
}

export interface AuditQueryResult {
	events: AuditEvent[];
	total: number;
	query: AuditQuery;
}

export interface AuditConfig {
	auditDir: string;
	retentionDays: number; // AC#5: Default 90 days
	maxFileSize: number; // Max size per log file before rotation (default 10MB)
	maxFiles: number; // Max number of log files to keep
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 100;
const AUDIT_FILE_PREFIX = "audit-";
const AUDIT_INDEX_FILE = "audit-index.jsonl";

// ─── Audit Trail Implementation ──────────────────────────────────────

export class AuditTrail {
	private config: AuditConfig;
	private currentLogFile: string | null = null;
	private eventBuffer: AuditEvent[] = [];
	private flushInterval: ReturnType<typeof setInterval> | null = null;
	private readonly flushIntervalMs = 5000; // Flush every 5 seconds
	private readonly maxBufferSize = 100; // Flush when buffer reaches this size

	constructor(config?: Partial<AuditConfig>) {
		this.config = {
			auditDir: config?.auditDir ?? join(process.cwd(), ".roadmap", "audit"),
			retentionDays: config?.retentionDays ?? DEFAULT_RETENTION_DAYS,
			maxFileSize: config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
			maxFiles: config?.maxFiles ?? DEFAULT_MAX_FILES,
		};
	}

	/**
	 * Initialize the audit trail system.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.config.auditDir, { recursive: true });
		await this.rotateLogFileIfNeeded();

		// Start periodic flush
		this.flushInterval = setInterval(() => {
			this.flush().catch(console.error);
		}, this.flushIntervalMs);
	}

	/**
	 * Shutdown and flush remaining events.
	 */
	async shutdown(): Promise<void> {
		if (this.flushInterval) {
			clearInterval(this.flushInterval);
			this.flushInterval = null;
		}
		await this.flush();
	}

	/**
	 * AC#1: Log a proposal transition event.
	 */
	async logProposalTransition(
		agentId: string,
		proposalId: string,
		fromStatus: string,
		toStatus: string,
		details?: Record<string, unknown>,
	): Promise<AuditEvent> {
		return this.logEvent({
			type: "proposal_transition",
			agentId,
			action: `proposal:${fromStatus}→${toStatus}`,
			resource: "proposal",
			resourceId: proposalId,
			success: true,
			details: {
				fromStatus,
				toStatus,
				...details,
			},
		});
	}

	/**
	 * AC#2: Log authentication success.
	 */
	async logAuthSuccess(
		agentId: string,
		authMethod: string,
		details?: Record<string, unknown>,
	): Promise<AuditEvent> {
		return this.logEvent({
			type: "auth_success",
			agentId,
			action: `auth:${authMethod}`,
			resource: "auth",
			success: true,
			details: { method: authMethod, ...details },
		});
	}

	/**
	 * AC#2: Log authentication failure.
	 */
	async logAuthFailure(
		agentId: string,
		reason: string,
		details?: Record<string, unknown>,
	): Promise<AuditEvent> {
		return this.logEvent({
			type: "auth_failure",
			agentId,
			action: "auth:failed",
			resource: "auth",
			success: false,
			details: { reason, ...details },
		});
	}

	/**
	 * AC#3: Log rate limit violation.
	 */
	async logRateLimitViolation(
		agentId: string,
		endpoint: string,
		limit: number,
		current: number,
	): Promise<AuditEvent> {
		return this.logEvent({
			type: "rate_limit_violation",
			agentId,
			action: "rate_limit:exceeded",
			resource: "rate_limit",
			success: false,
			details: {
				endpoint,
				limit,
				current,
				exceededBy: current - limit,
			},
		});
	}

	/**
	 * Log a generic event.
	 */
	async logEvent(
		event: Omit<AuditEvent, "id" | "timestamp">,
	): Promise<AuditEvent> {
		const fullEvent: AuditEvent = {
			...event,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
		};

		this.eventBuffer.push(fullEvent);

		// Flush if buffer is full
		if (this.eventBuffer.length >= this.maxBufferSize) {
			await this.flush();
		}

		return fullEvent;
	}

	/**
	 * Flush buffered events to disk.
	 */
	async flush(): Promise<void> {
		if (this.eventBuffer.length === 0) return;

		const events = [...this.eventBuffer];
		this.eventBuffer = [];

		// Ensure directory exists
		await mkdir(this.config.auditDir, { recursive: true });

		await this.rotateLogFileIfNeeded();

		// Append events to current log file
		const logFile = this.getLogFilePath();
		const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

		await writeFile(logFile, lines, { flag: "a" });

		// Update index
		await this.updateIndex(events);
	}

	/**
	 * AC#4: Query audit logs.
	 */
	async query(query: AuditQuery): Promise<AuditQueryResult> {
		const allEvents = await this.loadAllEvents();
		let filtered = allEvents;

		// Apply filters
		if (query.eventType) {
			filtered = filtered.filter((e) => e.type === query.eventType);
		}
		if (query.agentId) {
			filtered = filtered.filter((e) => e.agentId === query.agentId);
		}
		if (query.startTime) {
			filtered = filtered.filter((e) => e.timestamp >= query.startTime!);
		}
		if (query.endTime) {
			filtered = filtered.filter((e) => e.timestamp <= query.endTime!);
		}
		if (query.resource) {
			filtered = filtered.filter((e) => e.resource === query.resource);
		}
		if (query.success !== undefined) {
			filtered = filtered.filter((e) => e.success === query.success);
		}

		// Sort by timestamp (newest first)
		filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		const total = filtered.length;
		const offset = query.offset ?? 0;
		const limit = query.limit ?? 100;
		const events = filtered.slice(offset, offset + limit);

		return { events, total, query };
	}

	/**
	 * AC#5: Get audit log statistics.
	 */
	async getStats(): Promise<{
		totalEvents: number;
		eventTypes: Record<string, number>;
		oldestEvent: string | null;
		newestEvent: string | null;
		retentionDays: number;
		logFiles: number;
	}> {
		const files = await this.getLogFiles();
		const allEvents = await this.loadAllEvents();

		const eventTypes: Record<string, number> = {};
		for (const event of allEvents) {
			eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
		}

		const timestamps = allEvents.map((e) => e.timestamp).sort();

		return {
			totalEvents: allEvents.length,
			eventTypes,
			oldestEvent: timestamps[0] ?? null,
			newestEvent: timestamps[timestamps.length - 1] ?? null,
			retentionDays: this.config.retentionDays,
			logFiles: files.length,
		};
	}

	/**
	 * AC#5: Purge events older than retention period.
	 */
	async purgeOldEvents(): Promise<number> {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
		const cutoffIso = cutoff.toISOString();

		const allEvents = await this.loadAllEvents();
		const retained = allEvents.filter((e) => e.timestamp >= cutoffIso);
		const purged = allEvents.length - retained.length;

		if (purged > 0) {
			// Rewrite log files with only retained events
			await this.rewriteLogs(retained);
		}

		return purged;
	}

	// ─── Internal Methods ────────────────────────────────────────────

	private getLogFilePath(): string {
		if (!this.currentLogFile) {
			const date = new Date().toISOString().slice(0, 10);
			this.currentLogFile = join(
				this.config.auditDir,
				`${AUDIT_FILE_PREFIX}${date}-${randomUUID().slice(0, 8)}.jsonl`,
			);
		}
		return this.currentLogFile;
	}

	private async rotateLogFileIfNeeded(): Promise<void> {
		if (!this.currentLogFile) return;

		try {
			const stats = await readFile(this.currentLogFile);
			if (stats.length >= this.config.maxFileSize) {
				// Rotate to new file
				const date = new Date().toISOString().slice(0, 10);
				this.currentLogFile = join(
					this.config.auditDir,
					`${AUDIT_FILE_PREFIX}${date}-${randomUUID().slice(0, 8)}.jsonl`,
				);
				await this.cleanupOldFiles();
			}
		} catch {
			// File doesn't exist yet, fine
		}
	}

	private async cleanupOldFiles(): Promise<void> {
		const files = await this.getLogFiles();
		if (files.length > this.config.maxFiles) {
			// Delete oldest files
			const toDelete = files.slice(0, files.length - this.config.maxFiles);
			for (const file of toDelete) {
				await unlink(file);
			}
		}
	}

	private async getLogFiles(): Promise<string[]> {
		try {
			const entries = await readdir(this.config.auditDir);
			return entries
				.filter((f) => f.startsWith(AUDIT_FILE_PREFIX) && f.endsWith(".jsonl"))
				.map((f) => join(this.config.auditDir, f))
				.sort();
		} catch {
			return [];
		}
	}

	private async loadAllEvents(): Promise<AuditEvent[]> {
		// Flush current buffer first
		await this.flush();

		const files = await this.getLogFiles();
		const events: AuditEvent[] = [];

		for (const file of files) {
			try {
				const content = await readFile(file, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						events.push(JSON.parse(line) as AuditEvent);
					} catch {
						// Skip malformed lines
					}
				}
			} catch {
				// Skip unreadable files
			}
		}

		return events;
	}

	private async updateIndex(events: AuditEvent[]): Promise<void> {
		const indexPath = join(this.config.auditDir, AUDIT_INDEX_FILE);
		const lines = events.map((e) =>
			JSON.stringify({
				id: e.id,
				timestamp: e.timestamp,
				type: e.type,
				agentId: e.agentId,
			}),
		);
		await writeFile(indexPath, `${lines.join("\n")}\n`, { flag: "a" });
	}

	private async rewriteLogs(events: AuditEvent[]): Promise<void> {
		// Clear current files
		const files = await this.getLogFiles();
		for (const file of files) {
			await unlink(file).catch(() => {});
		}

		// Write all retained events to a single file
		this.currentLogFile = null;
		if (events.length > 0) {
			const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await writeFile(this.getLogFilePath(), lines);
		}
	}
}

// ─── Audit Trail Singleton ───────────────────────────────────────────

let globalAuditTrail: AuditTrail | null = null;

/**
 * Get or create the global audit trail instance.
 */
export function getAuditTrail(config?: Partial<AuditConfig>): AuditTrail {
	if (!globalAuditTrail) {
		globalAuditTrail = new AuditTrail(config);
	}
	return globalAuditTrail;
}

/**
 * Reset the global audit trail (for testing).
 */
export function resetAuditTrail(): void {
	globalAuditTrail = null;
}

// ─── Query Helpers ───────────────────────────────────────────────────

/**
 * AC#4: Format audit events for MCP tool output.
 */
export function formatAuditEvents(
	events: AuditEvent[],
	format: "table" | "json" | "text" = "text",
): string {
	if (format === "json") {
		return JSON.stringify(events, null, 2);
	}

	if (format === "table") {
		const header =
			"TIMESTAMP                  | TYPE                  | AGENT              | ACTION              | SUCCESS";
		const separator = "-".repeat(header.length);
		const rows = events.map(
			(e) =>
				`${e.timestamp.slice(0, 26).padEnd(26)} | ${e.type.padEnd(21)} | ${e.agentId.slice(0, 18).padEnd(18)} | ${e.action.slice(0, 19).padEnd(19)} | ${e.success ? "✓" : "✗"}`,
		);
		return [header, separator, ...rows].join("\n");
	}

	// Text format
	return events
		.map((e) => {
			const status = e.success ? "✓" : "✗";
			let line = `[${e.timestamp}] ${status} ${e.type} | ${e.agentId} | ${e.action}`;
			if (e.resourceId) line += ` | ${e.resource}:${e.resourceId}`;
			if (e.details) line += ` | ${JSON.stringify(e.details)}`;
			return line;
		})
		.join("\n");
}
