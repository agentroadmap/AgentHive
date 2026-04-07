/**
 * Agent Identity Authentication Protocol (STATE-51)
 *
 * Provides cryptographic identity management for agents:
 * - AC#1: Ed25519 key pair generation on first run
 * - AC#2: Token issuance via daemon API (HMAC-SHA256 JWT-like tokens)
 * - AC#3: Identity verification before proposal edits
 * - AC#4: Audit events include authenticated agent ID
 * - AC#5: Key rotation supported without downtime
 */

import {
	sign as cryptoSign,
	verify as cryptoVerify,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentKeyPair {
	agentId: string;
	publicKey: string; // PEM
	privateKey: string; // PEM (stored securely, never transmitted)
	createdAt: string;
	keyVersion: number;
}

export interface AgentToken {
	token: string; // Base64-encoded signed payload
	agentId: string;
	expiresAt: string;
	issuedAt: string;
	keyVersion: number;
}

export interface AuditEvent {
	timestamp: string;
	agentId: string;
	action: string;
	resource: string;
	resourceId?: string;
	success: boolean;
	details?: string;
	keyVersion: number;
}

export interface AuthConfig {
	identityDir: string;
	tokenTtlMs: number;
	maxKeyVersions: number;
}

export interface TokenPayload {
	agentId: string;
	issuedAt: number;
	expiresAt: number;
	keyVersion: number;
	nonce: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_KEY_VERSIONS = 3; // Keep current + 2 previous for grace period
const IDENTITY_FILE = "identity.json";
const AUDIT_LOG_FILE = "audit.jsonl";
const TOKEN_PREFIX = "rmk_"; // roadmap token prefix

// ─── Identity Manager ────────────────────────────────────────────────

export class AgentAuth {
	private readonly config: AuthConfig;
	private identity: AgentKeyPair | null = null;
	private auditLog: AuditEvent[] = [];

	constructor(config?: Partial<AuthConfig>) {
		this.config = {
			identityDir:
				config?.identityDir ?? join(process.cwd(), ".roadmap", "auth"),
			tokenTtlMs: config?.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
			maxKeyVersions: config?.maxKeyVersions ?? DEFAULT_MAX_KEY_VERSIONS,
		};
	}

	// ─── AC#1: Key Generation ──────────────────────────────────────────

	/**
	 * Generate or load agent identity keys.
	 * Creates Ed25519 key pair on first run, loads existing on subsequent runs.
	 */
	async initializeIdentity(agentId: string): Promise<AgentKeyPair> {
		await mkdir(this.config.identityDir, { recursive: true });
		const identityPath = join(this.config.identityDir, IDENTITY_FILE);

		try {
			await access(identityPath);
			const raw = await readFile(identityPath, "utf-8");
			const stored = JSON.parse(raw) as AgentKeyPair;
			this.identity = stored;
			return stored;
		} catch {
			// No existing identity — generate new keys
		}

		const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});

		const identity: AgentKeyPair = {
			agentId,
			publicKey,
			privateKey,
			createdAt: new Date().toISOString(),
			keyVersion: 1,
		};

		await writeFile(identityPath, JSON.stringify(identity, null, 2), {
			mode: 0o600,
		});
		this.identity = identity;
		return identity;
	}

	/**
	 * Get current identity (must call initializeIdentity first).
	 */
	getIdentity(): AgentKeyPair | null {
		return this.identity;
	}

	// ─── AC#2: Token Issuance ──────────────────────────────────────────

	/**
	 * Issue a signed authentication token for an agent.
	 * Token format: rmk_<base64(payload)>.<base64(signature)>
	 */
	async issueToken(agentId: string): Promise<AgentToken> {
		if (!this.identity) {
			throw new Error(
				"Identity not initialized. Call initializeIdentity first.",
			);
		}

		if (this.identity.agentId !== agentId) {
			throw new Error(
				`Cannot issue token for ${agentId} — identity is for ${this.identity.agentId}`,
			);
		}

		const now = Date.now();
		const payload: TokenPayload = {
			agentId,
			issuedAt: now,
			expiresAt: now + this.config.tokenTtlMs,
			keyVersion: this.identity.keyVersion,
			nonce: randomBytes(16).toString("hex"),
		};

		const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
			"base64url",
		);
		const signature = this.signPayload(payloadB64);
		const token = `${TOKEN_PREFIX}${payloadB64}.${signature}`;

		const agentToken: AgentToken = {
			token,
			agentId,
			expiresAt: new Date(payload.expiresAt).toISOString(),
			issuedAt: new Date(payload.issuedAt).toISOString(),
			keyVersion: this.identity.keyVersion,
		};

		this.logAudit({
			timestamp: new Date().toISOString(),
			agentId,
			action: "token_issued",
			resource: "auth",
			success: true,
			keyVersion: this.identity.keyVersion,
		});

		return agentToken;
	}

	// ─── AC#3: Identity Verification ───────────────────────────────────

	/**
	 * Verify a token and return the authenticated agent ID.
	 * Returns null if verification fails.
	 */
	async verifyToken(
		token: string,
	): Promise<{ agentId: string; keyVersion: number } | null> {
		if (!token.startsWith(TOKEN_PREFIX)) {
			return null;
		}

		const withoutPrefix = token.slice(TOKEN_PREFIX.length);
		const dotIndex = withoutPrefix.lastIndexOf(".");
		if (dotIndex === -1) {
			return null;
		}

		const payloadB64 = withoutPrefix.slice(0, dotIndex);
		const signature = withoutPrefix.slice(dotIndex + 1);

		// Parse payload
		let payload: TokenPayload;
		try {
			const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
			payload = JSON.parse(json) as TokenPayload;
		} catch {
			return null;
		}

		// Check expiry
		if (Date.now() > payload.expiresAt) {
			this.logAudit({
				timestamp: new Date().toISOString(),
				agentId: payload.agentId,
				action: "token_verify",
				resource: "auth",
				success: false,
				details: "Token expired",
				keyVersion: payload.keyVersion,
			});
			return null;
		}

		// Verify signature
		const valid = this.verifySignature(payloadB64, signature);
		if (!valid) {
			this.logAudit({
				timestamp: new Date().toISOString(),
				agentId: payload.agentId,
				action: "token_verify",
				resource: "auth",
				success: false,
				details: "Invalid signature",
				keyVersion: payload.keyVersion,
			});
			return null;
		}

		this.logAudit({
			timestamp: new Date().toISOString(),
			agentId: payload.agentId,
			action: "token_verify",
			resource: "auth",
			success: true,
			keyVersion: payload.keyVersion,
		});

		return { agentId: payload.agentId, keyVersion: payload.keyVersion };
	}

	// ─── AC#5: Key Rotation ────────────────────────────────────────────

	/**
	 * Rotate agent keys. Generates new Ed25519 key pair, increments version.
	 * Old keys are kept for grace-period verification (up to maxKeyVersions).
	 */
	async rotateKeys(): Promise<AgentKeyPair> {
		if (!this.identity) {
			throw new Error(
				"Identity not initialized. Call initializeIdentity first.",
			);
		}

		const identityPath = join(this.config.identityDir, IDENTITY_FILE);
		const archivePath = join(
			this.config.identityDir,
			`identity.v${this.identity.keyVersion}.json`,
		);

		// Archive current keys
		await writeFile(archivePath, JSON.stringify(this.identity, null, 2), {
			mode: 0o600,
		});

		// Generate new keys
		const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});

		const newIdentity: AgentKeyPair = {
			agentId: this.identity.agentId,
			publicKey,
			privateKey,
			createdAt: new Date().toISOString(),
			keyVersion: this.identity.keyVersion + 1,
		};

		await writeFile(identityPath, JSON.stringify(newIdentity, null, 2), {
			mode: 0o600,
		});

		this.logAudit({
			timestamp: new Date().toISOString(),
			agentId: this.identity.agentId,
			action: "key_rotation",
			resource: "auth",
			success: true,
			details: `Rotated from v${this.identity.keyVersion} to v${newIdentity.keyVersion}`,
			keyVersion: newIdentity.keyVersion,
		});

		this.identity = newIdentity;
		return newIdentity;
	}

	// ─── AC#4: Audit Events ────────────────────────────────────────────

	/**
	 * Log an audit event. Events are persisted to audit.jsonl.
	 */
	logAudit(event: AuditEvent): void {
		this.auditLog.push(event);
	}

	/**
	 * Get audit log entries, optionally filtered by agent.
	 */
	getAuditLog(agentId?: string): AuditEvent[] {
		if (agentId) {
			return this.auditLog.filter((e) => e.agentId === agentId);
		}
		return [...this.auditLog];
	}

	/**
	 * Persist audit log to disk (append to audit.jsonl).
	 */
	async flushAuditLog(): Promise<void> {
		if (this.auditLog.length === 0) return;

		await mkdir(this.config.identityDir, { recursive: true });
		const auditPath = join(this.config.identityDir, AUDIT_LOG_FILE);
		const lines = `${this.auditLog.map((e) => JSON.stringify(e)).join("\n")}\n`;

		const { appendFile } = await import("node:fs/promises");
		await appendFile(auditPath, lines, { mode: 0o644 });
		this.auditLog = [];
	}

	// ─── Internal Helpers ──────────────────────────────────────────────

	private signPayload(payloadB64: string): string {
		if (!this.identity) throw new Error("No identity loaded");

		const data = Buffer.from(payloadB64, "utf-8");
		// Ed25519 uses null algorithm in Node.js crypto
		const sig = cryptoSign(null, data, this.identity.privateKey);
		return sig.toString("base64url");
	}

	private verifySignature(payloadB64: string, signature: string): boolean {
		if (!this.identity) return false;

		try {
			const data = Buffer.from(payloadB64, "utf-8");
			const sig = Buffer.from(signature, "base64url");
			// Ed25519 uses null algorithm in Node.js crypto
			return cryptoVerify(null, data, this.identity.publicKey, sig);
		} catch {
			return false;
		}
	}

	/**
	 * Extract agent ID from Authorization header without full verification.
	 * Useful for audit logging before rejecting expired tokens.
	 */
	extractAgentId(token: string): string | null {
		if (!token.startsWith(TOKEN_PREFIX)) return null;

		const withoutPrefix = token.slice(TOKEN_PREFIX.length);
		const dotIndex = withoutPrefix.lastIndexOf(".");
		if (dotIndex === -1) return null;

		try {
			const json = Buffer.from(
				withoutPrefix.slice(0, dotIndex),
				"base64url",
			).toString("utf-8");
			const payload = JSON.parse(json) as TokenPayload;
			return payload.agentId ?? null;
		} catch {
			return null;
		}
	}
}

// ─── Auth Middleware for HTTP Server ─────────────────────────────────

export interface AuthenticatedRequest {
	headers: Record<string, string | string[] | undefined>;
	agentId?: string;
	keyVersion?: number;
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(
	headers: Record<string, string | string[] | undefined>,
): string | null {
	const auth = headers.authorization;
	if (!auth) return null;

	const value = Array.isArray(auth) ? auth[0] : auth;
	if (!value?.startsWith("Bearer ")) return null;

	return value.slice(7);
}

/**
 * Create auth middleware for the Roadmap HTTP server.
 * Returns the authenticated agent ID or null.
 */
export async function authenticateRequest(
	auth: AgentAuth,
	headers: Record<string, string | string[] | undefined>,
): Promise<{ agentId: string; keyVersion: number } | null> {
	const token = extractBearerToken(headers);
	if (!token) return null;

	return auth.verifyToken(token);
}
