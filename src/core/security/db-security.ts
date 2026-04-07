/**
 * Database Migration Security Layer (STATE-095 AC#5)
 *
 * Security & data integrity for file-to-database migration:
 * - AC#5a: Access control model (file perms → DB permissions)
 * - AC#5b: Audit trail migration (git log → event table)
 * - AC#5c: Data integrity verification during migration
 * - AC#5d: Secret/credential handling in DB context
 */

import { createHash, randomUUID } from "node:crypto";
// SQLite removed

// ─── Types ───────────────────────────────────────────────────────────

export interface MigrationAuditEvent {
	id: string;
	timestamp: string;
	agentId: string;
	action: string;
	resourceType: "proposal" | "document" | "decision" | "secret" | "config";
	resourceId: string;
	beforeHash: string | null;
	afterHash: string | null;
	source: "file" | "database" | "migration";
	keyVersion: number;
}

export interface DataIntegrityCheck {
	id: string;
	resourceType: string;
	resourceId: string;
	fileHash: string;
	dbHash: string;
	match: boolean;
	checkedAt: string;
}

export interface AccessControlEntry {
	agentId: string;
	resourceType: string;
	resourceId: string | "*"; // wildcard for all resources of type
	permissions: Array<"read" | "write" | "delete" | "admin">;
	grantedAt: string;
	grantedBy: string;
}

export interface MigrationSecurityConfig {
	dbPath: string;
	requireAuth: boolean;
	auditRetentionDays: number;
	enableIntegrityChecks: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const HASH_ALGORITHM = "sha256";

// ─── Security Schema ────────────────────────────────────────────────

export function initializeSecuritySchema(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			action TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			before_hash TEXT,
			after_hash TEXT,
			source TEXT NOT NULL DEFAULT 'database',
			key_version INTEGER NOT NULL DEFAULT 1,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
	`);

	// Access control table
	db.exec(`
		CREATE TABLE IF NOT EXISTS access_control (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL DEFAULT '*',
			permission TEXT NOT NULL,
			granted_at TEXT NOT NULL,
			granted_by TEXT NOT NULL,
			revoked_at TEXT,
			revoked_by TEXT
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_acl_agent ON access_control(agent_id);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_acl_resource ON access_control(resource_type, resource_id);
	`);

	// Data integrity verification table
	db.exec(`
		CREATE TABLE IF NOT EXISTS integrity_checks (
			id TEXT PRIMARY KEY,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			file_hash TEXT NOT NULL,
			db_hash TEXT NOT NULL,
			match INTEGER NOT NULL,
			checked_at TEXT DEFAULT (datetime('now'))
		)
	`);

	// Agent auth tokens table (DB-backed, replacing file-only auth)
	db.exec(`
		CREATE TABLE IF NOT EXISTS agent_tokens (
			token_hash TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			issued_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			key_version INTEGER NOT NULL,
			revoked INTEGER NOT NULL DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_tokens_agent ON agent_tokens(agent_id);
	`);

	// Encrypted config storage (replaces plaintext file configs)
	db.exec(`
		CREATE TABLE IF NOT EXISTS encrypted_configs (
			key TEXT PRIMARY KEY,
			encrypted_value TEXT NOT NULL,
			iv TEXT NOT NULL,
			tag TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			updated_at TEXT DEFAULT (datetime('now'))
		)
	`);
}

// ─── Audit Trail ────────────────────────────────────────────────────

export class AuditTrail {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Log an audit event. Replaces git log as the authoritative audit source.
	 */
	logEvent(
		event: Omit<MigrationAuditEvent, "id" | "timestamp">,
	): MigrationAuditEvent {
		const full: MigrationAuditEvent = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			...event,
		};

		const stmt = this.db.prepare(`
			INSERT INTO audit_events (id, timestamp, agent_id, action, resource_type, resource_id, before_hash, after_hash, source, key_version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			full.id,
			full.timestamp,
			full.agentId,
			full.action,
			full.resourceType,
			full.resourceId,
			full.beforeHash,
			full.afterHash,
			full.source,
			full.keyVersion,
		);

		return full;
	}

	/**
	 * Query audit events with optional filters.
	 */
	queryEvents(filters: {
		agentId?: string;
		resourceType?: string;
		resourceId?: string;
		action?: string;
		since?: string;
		limit?: number;
	}): MigrationAuditEvent[] {
		let sql = "SELECT * FROM audit_events WHERE 1=1";
		const params: any[] = [];

		if (filters.agentId) {
			sql += " AND agent_id = ?";
			params.push(filters.agentId);
		}
		if (filters.resourceType) {
			sql += " AND resource_type = ?";
			params.push(filters.resourceType);
		}
		if (filters.resourceId) {
			sql += " AND resource_id = ?";
			params.push(filters.resourceId);
		}
		if (filters.action) {
			sql += " AND action = ?";
			params.push(filters.action);
		}
		if (filters.since) {
			sql += " AND timestamp >= ?";
			params.push(filters.since);
		}

		sql += " ORDER BY timestamp DESC";

		if (filters.limit) {
			sql += " LIMIT ?";
			params.push(filters.limit);
		}

		const rows = this.db.prepare(sql).all(...params) as Array<{
			id: string;
			timestamp: string;
			agent_id: string;
			action: string;
			resource_type: string;
			resource_id: string;
			before_hash: string | null;
			after_hash: string | null;
			source: string;
			key_version: number;
		}>;

		return rows.map((r) => ({
			id: r.id,
			timestamp: r.timestamp,
			agentId: r.agent_id,
			action: r.action,
			resourceType: r.resource_type as MigrationAuditEvent["resourceType"],
			resourceId: r.resource_id,
			beforeHash: r.before_hash,
			afterHash: r.after_hash,
			source: r.source as MigrationAuditEvent["source"],
			keyVersion: r.key_version,
		}));
	}

	/**
	 * Purge audit events older than retention period.
	 */
	purgeOldEvents(retentionDays: number): number {
		const cutoff = new Date(
			Date.now() - retentionDays * 86400000,
		).toISOString();
		const stmt = this.db.prepare(
			"DELETE FROM audit_events WHERE timestamp < ?",
		);
		const result = stmt.run(cutoff);
		return Number(result.changes);
	}
}

// ─── Access Control ─────────────────────────────────────────────────

export class AccessControl {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Grant a permission to an agent for a resource.
	 */
	grant(
		agentId: string,
		resourceType: string,
		resourceId: string,
		permission: AccessControlEntry["permissions"][number],
		grantedBy: string,
	): void {
		const stmt = this.db.prepare(`
			INSERT INTO access_control (id, agent_id, resource_type, resource_id, permission, granted_at, granted_by)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			randomUUID(),
			agentId,
			resourceType,
			resourceId,
			permission,
			new Date().toISOString(),
			grantedBy,
		);
	}

	/**
	 * Check if an agent has a specific permission on a resource.
	 * Checks both specific resource and wildcard entries.
	 */
	hasPermission(
		agentId: string,
		resourceType: string,
		resourceId: string,
		permission: string,
	): boolean {
		const stmt = this.db.prepare(`
			SELECT COUNT(*) as cnt FROM access_control
			WHERE agent_id = ?
			AND resource_type = ?
			AND (resource_id = ? OR resource_id = '*')
			AND permission = ?
			AND revoked_at IS NULL
		`);

		const result = stmt.get(agentId, resourceType, resourceId, permission) as {
			cnt: number;
		};
		return result.cnt > 0;
	}

	/**
	 * Revoke a permission.
	 */
	revoke(
		agentId: string,
		resourceType: string,
		resourceId: string,
		permission: string,
		revokedBy: string,
	): boolean {
		const stmt = this.db.prepare(`
			UPDATE access_control
			SET revoked_at = ?, revoked_by = ?
			WHERE agent_id = ?
			AND resource_type = ?
			AND (resource_id = ? OR resource_id = '*')
			AND permission = ?
			AND revoked_at IS NULL
		`);

		const result = stmt.run(
			new Date().toISOString(),
			revokedBy,
			agentId,
			resourceType,
			resourceId,
			permission,
		);

		return result.changes > 0;
	}

	/**
	 * List all active permissions for an agent.
	 */
	listPermissions(agentId: string): AccessControlEntry[] {
		const rows = this.db
			.prepare(`
			SELECT * FROM access_control
			WHERE agent_id = ? AND revoked_at IS NULL
			ORDER BY granted_at DESC
		`)
			.all(agentId) as Array<{
			agent_id: string;
			resource_type: string;
			resource_id: string;
			permission: string;
			granted_at: string;
			granted_by: string;
		}>;

		return rows.map((r) => ({
			agentId: r.agent_id,
			resourceType: r.resource_type,
			resourceId: r.resource_id,
			permissions: [r.permission as AccessControlEntry["permissions"][number]],
			grantedAt: r.granted_at,
			grantedBy: r.granted_by,
		}));
	}
}

// ─── Data Integrity ─────────────────────────────────────────────────

export class DataIntegrity {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Compute SHA-256 hash of content for integrity verification.
	 */
	static computeHash(content: string): string {
		return createHash(HASH_ALGORITHM).update(content).digest("hex");
	}

	/**
	 * Record an integrity check between file and DB versions.
	 */
	recordCheck(
		resourceType: string,
		resourceId: string,
		fileContent: string,
		dbContent: string,
	): DataIntegrityCheck {
		const fileHash = DataIntegrity.computeHash(fileContent);
		const dbHash = DataIntegrity.computeHash(dbContent);

		const check: DataIntegrityCheck = {
			id: randomUUID(),
			resourceType,
			resourceId,
			fileHash,
			dbHash,
			match: fileHash === dbHash,
			checkedAt: new Date().toISOString(),
		};

		const stmt = this.db.prepare(`
			INSERT INTO integrity_checks (id, resource_type, resource_id, file_hash, db_hash, match, checked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			check.id,
			check.resourceType,
			check.resourceId,
			check.fileHash,
			check.dbHash,
			check.match ? 1 : 0,
			check.checkedAt,
		);

		return check;
	}

	/**
	 * Get all integrity mismatches.
	 */
	getMismatches(): DataIntegrityCheck[] {
		const rows = this.db
			.prepare(`
			SELECT * FROM integrity_checks WHERE match = 0 ORDER BY checked_at DESC
		`)
			.all() as Array<{
			id: string;
			resource_type: string;
			resource_id: string;
			file_hash: string;
			db_hash: string;
			match: number;
			checked_at: string;
		}>;

		return rows.map((r) => ({
			id: r.id,
			resourceType: r.resource_type,
			resourceId: r.resource_id,
			fileHash: r.file_hash,
			dbHash: r.db_hash,
			match: r.match === 1,
			checkedAt: r.checked_at,
		}));
	}

	/**
	 * Verify all proposals in DB match their file counterparts.
	 * Returns count of verified, mismatched, and missing.
	 */
	verifyAll(
		proposals: Array<{ id: string; fileContent: string; dbContent: string }>,
	): {
		verified: number;
		mismatched: number;
		missing: number;
	} {
		let verified = 0;
		let mismatched = 0;
		let missing = 0;

		for (const proposal of proposals) {
			if (!proposal.dbContent) {
				missing++;
				continue;
			}

			const check = this.recordCheck(
				"proposal",
				proposal.id,
				proposal.fileContent,
				proposal.dbContent,
			);
			if (check.match) {
				verified++;
			} else {
				mismatched++;
			}
		}

		return { verified, mismatched, missing };
	}
}

// ─── Agent Token Store (DB-backed) ──────────────────────────────────

export class AgentTokenStore {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Store a token hash (never store plaintext tokens in DB).
	 */
	storeToken(
		agentId: string,
		tokenHash: string,
		expiresAt: string,
		keyVersion: number,
	): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO agent_tokens (token_hash, agent_id, issued_at, expires_at, key_version)
			VALUES (?, ?, ?, ?, ?)
		`);

		stmt.run(
			tokenHash,
			agentId,
			new Date().toISOString(),
			expiresAt,
			keyVersion,
		);
	}

	/**
	 * Verify a token hash exists and is not expired/revoked.
	 */
	verifyTokenHash(
		tokenHash: string,
	): { agentId: string; keyVersion: number } | null {
		const row = this.db
			.prepare(`
			SELECT agent_id, key_version, expires_at, revoked
			FROM agent_tokens
			WHERE token_hash = ?
		`)
			.get(tokenHash) as
			| {
					agent_id: string;
					key_version: number;
					expires_at: string;
					revoked: number;
			  }
			| undefined;

		if (!row) return null;
		if (row.revoked) return null;
		if (new Date(row.expires_at) < new Date()) return null;

		return { agentId: row.agent_id, keyVersion: row.key_version };
	}

	/**
	 * Revoke all tokens for an agent (e.g., on key rotation or compromise).
	 */
	revokeAllForAgent(agentId: string): number {
		const stmt = this.db.prepare(`
			UPDATE agent_tokens SET revoked = 1 WHERE agent_id = ? AND revoked = 0
		`);

		const result = stmt.run(agentId);
		return Number(result.changes);
	}

	/**
	 * Purge expired tokens.
	 */
	purgeExpired(): number {
		const stmt = this.db.prepare(`
			DELETE FROM agent_tokens WHERE expires_at < datetime('now')
		`);

		const result = stmt.run();
		return Number(result.changes);
	}
}

// ─── Utility ────────────────────────────────────────────────────────

/**
 * Initialize all security tables in a database.
 */
export function initializeSecurity(db: DatabaseSync): void {
	initializeSecuritySchema(db);
}
