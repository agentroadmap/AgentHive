/**
 * Agent Identity Authentication Protocol
 *
 * Implements STATE-51: Cryptographic identity for agents.
 *
 * AC#1: Agent identity keys generated on first run
 * AC#2: Token issuance via daemon API
 * AC#3: Identity verification before proposal edits
 * AC#4: Audit events include authenticated agent ID
 * AC#5: Key rotation supported without downtime
 */

import {
	createHash,
	sign as cryptoSign,
	verify as cryptoVerify,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentPublicKey,
	registerAgent,
	updateAgentPublicKey,
} from "./agent-registry/index.ts";

/** Key algorithm used for agent identities */
const _KEY_ALGORITHM = "ed25519";

/** Token expiration time in milliseconds (24 hours) */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Directory for storing agent keys */
const KEY_DIR = ".agent-keys";

/** Identity file extension */
const KEY_EXT = ".json";

// ===================== Types =====================

/** Stored agent key pair */
export interface AgentKeyPair {
	agentId: string;
	publicKey: string;
	privateKey: string; // PEM encoded
	created: string; // ISO timestamp
	rotated?: string; // ISO timestamp of last rotation
	version: number; // Key version for rotation tracking
}

/** Authentication token */
export interface AuthToken {
	token: string;
	agentId: string;
	publicKey: string;
	issued: number; // Unix timestamp ms
	expires: number; // Unix timestamp ms
	signature: string; // Signature of (agentId|issued|expires) with private key
	keyVersion: number;
}

/** Audit event with authentication */
export interface AuthenticatedAuditEvent {
	eventId: string;
	timestamp: string;
	agentId: string;
	action: string;
	target: string;
	details: Record<string, unknown>;
	signature: string; // Signed by agent
}

/** Token verification result */
export interface TokenVerification {
	valid: boolean;
	agentId: string | null;
	reason: string;
	expired: boolean;
}

type RegisterIdentityFn = typeof registerAgent;
type UpdatePublicKeyFn = typeof updateAgentPublicKey;
type LookupPublicKeyFn = typeof getAgentPublicKey;

type IdentityRegistryOptions = {
	registerIdentity?: RegisterIdentityFn;
};

type RotationRegistryOptions = {
	updatePublicKey?: UpdatePublicKeyFn;
};

async function syncIdentityToRegistry(
	keyPair: AgentKeyPair,
	registerIdentity: RegisterIdentityFn = registerAgent,
): Promise<void> {
	try {
		await registerIdentity({
			agentId: keyPair.agentId,
			instanceId: keyPair.agentId,
			publicKey: keyPair.publicKey,
		});
	} catch {
		// DB unavailable or key conflict — file system remains authoritative
	}
}

// ===================== Key Generation =====================

/**
 * Generate a new Ed25519 key pair for an agent
 * AC#1: Agent identity keys generated on first run
 */
export function generateAgentKeyPair(agentId: string): AgentKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});

	return {
		agentId,
		publicKey,
		privateKey,
		created: new Date().toISOString(),
		version: 1,
	};
}

/**
 * Derive agent ID from public key (SHA-256 fingerprint)
 */
export function deriveAgentId(publicKey: string): string {
	const hash = createHash("sha256");
	hash.update(publicKey);
	const hex = hash.digest("hex");
	return `agent-${hex.substring(0, 16)}`;
}

/**
 * Get stable agent identifier (short form for display)
 */
export function getShortAgentId(agentId: string): string {
	return agentId.replace("agent-", "").substring(0, 8);
}

// ===================== Key Storage =====================

/**
 * Get the key storage directory path
 */
export function getKeyDir(workspaceRoot: string): string {
	return join(workspaceRoot, KEY_DIR);
}

/**
 * Get key file path for an agent
 */
export function getKeyPath(workspaceRoot: string, agentId: string): string {
	return join(getKeyDir(workspaceRoot), `${agentId}${KEY_EXT}`);
}

/**
 * Load agent key pair from disk
 */
export async function loadKeyPair(
	workspaceRoot: string,
	agentId: string,
): Promise<AgentKeyPair | null> {
	try {
		const keyPath = getKeyPath(workspaceRoot, agentId);
		const data = await readFile(keyPath, "utf-8");
		return JSON.parse(data) as AgentKeyPair;
	} catch {
		return null;
	}
}

/**
 * Save agent key pair to disk
 */
export async function saveKeyPair(
	workspaceRoot: string,
	keyPair: AgentKeyPair,
): Promise<void> {
	const keyDir = getKeyDir(workspaceRoot);
	await mkdir(keyDir, { recursive: true });
	const keyPath = getKeyPath(workspaceRoot, keyPair.agentId);
	await writeFile(keyPath, JSON.stringify(keyPair, null, 2), "utf-8");
}

/**
 * List all registered agent IDs
 */
export async function listAgentIds(workspaceRoot: string): Promise<string[]> {
	try {
		const keyDir = getKeyDir(workspaceRoot);
		const files = await readdir(keyDir);
		return files
			.filter((f) => f.endsWith(KEY_EXT))
			.map((f) => f.replace(KEY_EXT, ""));
	} catch {
		return [];
	}
}

/**
 * Get or create agent identity on first run
 * AC#1: Keys generated on first run, loaded from disk on subsequent runs
 */
export async function getOrCreateIdentity(
	workspaceRoot: string,
	agentName: string,
	options: IdentityRegistryOptions = {},
): Promise<AgentKeyPair> {
	// Derive deterministic agentId from name for consistent identity
	const nameHash = createHash("sha256").update(agentName).digest("hex");
	const tempAgentId = `agent-${nameHash.substring(0, 16)}`;

	// Check if key already exists
	const existing = await loadKeyPair(workspaceRoot, tempAgentId);
	if (existing) {
		await syncIdentityToRegistry(existing, options.registerIdentity);
		return existing;
	}

	// Generate new key pair
	const keyPair = generateAgentKeyPair(tempAgentId);
	await saveKeyPair(workspaceRoot, keyPair);

	// P159: Best-effort DB registration with public key. DB unavailable = OK,
	// file system is authoritative. Key conflict = rethrow (explicit invariant).
	try {
		await registerAgent({ agentId: tempAgentId, instanceId: tempAgentId, publicKey: keyPair.publicKey });
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Key conflict")) throw err;
		// DB connectivity failure — silently continue
	}

	return keyPair;
}

// ===================== Token Issuance =====================

/**
 * Issue an authentication token for an agent
 * AC#2: Token issuance via daemon API
 */
export function issueToken(keyPair: AgentKeyPair): AuthToken {
	const now = Date.now();
	const expires = now + TOKEN_EXPIRY_MS;
	const keyVersion = keyPair.version;

	// Create token payload
	const tokenPayload = `${keyPair.agentId}|${now}|${expires}|${keyVersion}`;
	const tokenHash = createHash("sha256").update(tokenPayload).digest("hex");
	const token = `tkt_${tokenHash}`;

	// Sign the token with agent's private key
	const signature = cryptoSign(
		null,
		Buffer.from(tokenPayload),
		keyPair.privateKey,
	).toString("hex");

	return {
		token,
		agentId: keyPair.agentId,
		publicKey: keyPair.publicKey,
		issued: now,
		expires,
		signature,
		keyVersion,
	};
}

/**
 * Serialize token for transport (base64 JSON)
 */
export function serializeToken(token: AuthToken): string {
	return Buffer.from(JSON.stringify(token)).toString("base64url");
}

/**
 * Deserialize token from transport format
 */
export function deserializeToken(data: string): AuthToken | null {
	try {
		const json = Buffer.from(data, "base64url").toString("utf-8");
		return JSON.parse(json) as AuthToken;
	} catch {
		return null;
	}
}

// ===================== Token Verification =====================

/**
 * Verify an authentication token
 * AC#3: Identity verification before proposal edits
 */
export function verifyToken(token: AuthToken): TokenVerification {
	// Check expiration
	const now = Date.now();
	if (now > token.expires) {
		return {
			valid: false,
			agentId: token.agentId,
			reason: "Token expired",
			expired: true,
		};
	}

	// Check not before issued time (clock skew tolerance: 5 min)
	const skewTolerance = 5 * 60 * 1000;
	if (now < token.issued - skewTolerance) {
		return {
			valid: false,
			agentId: token.agentId,
			reason: "Token not yet valid (future-dated)",
			expired: false,
		};
	}

	// Reconstruct payload and verify signature
	const tokenPayload = `${token.agentId}|${token.issued}|${token.expires}|${token.keyVersion}`;
	const tokenHash = createHash("sha256").update(tokenPayload).digest("hex");
	const expectedToken = `tkt_${tokenHash}`;

	if (token.token !== expectedToken) {
		return {
			valid: false,
			agentId: token.agentId,
			reason: "Token mismatch (tampered payload)",
			expired: false,
		};
	}

	// Verify cryptographic signature
	try {
		const isValid = cryptoVerify(
			null,
			Buffer.from(tokenPayload),
			token.publicKey,
			Buffer.from(token.signature, "hex"),
		);
		return {
			valid: isValid,
			agentId: token.agentId,
			reason: isValid ? "Token valid" : "Invalid signature",
			expired: false,
		};
	} catch {
		return {
			valid: false,
			agentId: token.agentId,
			reason: "Signature verification error",
			expired: false,
		};
	}
}

// ===================== Signature Operations =====================

/**
 * Sign arbitrary data with agent's private key
 */
export function signData(privateKey: string, data: string): string {
	return cryptoSign(null, Buffer.from(data), privateKey).toString("hex");
}

/**
 * Verify a signature against agent's public key
 */
export function verifySignature(
	publicKey: string,
	data: string,
	signature: string,
): boolean {
	try {
		return cryptoVerify(
			null,
			Buffer.from(data),
			publicKey,
			Buffer.from(signature, "hex"),
		);
	} catch {
		return false;
	}
}

// ===================== Key Rotation =====================

/**
 * Rotate agent keys without downtime
 * AC#5: Key rotation supported without downtime
 *
 * Creates a new key pair while preserving the agent ID.
 * Old keys can still verify signatures (they share the same agentId).
 */
export async function rotateKeyPair(
	workspaceRoot: string,
	currentKeyPair: AgentKeyPair,
	options: RotationRegistryOptions = {},
): Promise<{ newKeyPair: AgentKeyPair; previousPublicKey: string }> {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});

	const newKeyPair: AgentKeyPair = {
		agentId: currentKeyPair.agentId,
		publicKey,
		privateKey,
		created: currentKeyPair.created,
		rotated: new Date().toISOString(),
		version: currentKeyPair.version + 1,
	};

	// Archive old key for verification transition period
	const archivePath = join(
		getKeyDir(workspaceRoot),
		`${currentKeyPair.agentId}_v${currentKeyPair.version}${KEY_EXT}`,
	);
	await mkdir(dirname(archivePath), { recursive: true });
	await writeFile(
		archivePath,
		JSON.stringify(currentKeyPair, null, 2),
		"utf-8",
	);

	// Save new key as current
	await saveKeyPair(workspaceRoot, newKeyPair);

	// P159: Best-effort DB update for rotated key.
	try {
		await updateAgentPublicKey(currentKeyPair.agentId, newKeyPair.publicKey);
	} catch {
		// DB unavailable — file system already has the new key; rotation is safe.
	}

	return {
		newKeyPair,
		previousPublicKey: currentKeyPair.publicKey,
	};
}

/**
 * Load all historical key versions for an agent (for verification transition)
 */
export async function loadKeyHistory(
	workspaceRoot: string,
	agentId: string,
): Promise<AgentKeyPair[]> {
	const keyDir = getKeyDir(workspaceRoot);
	const keys: AgentKeyPair[] = [];

	try {
		const files = await readdir(keyDir);
		const prefix = `${agentId}_v`;

		for (const file of files) {
			if (file.startsWith(prefix) && file.endsWith(KEY_EXT)) {
				const data = await readFile(join(keyDir, file), "utf-8");
				keys.push(JSON.parse(data) as AgentKeyPair);
			}
		}
	} catch {
		// No history available
	}

	return keys;
}

// ===================== Audit Events =====================

/**
 * Create a signed audit event
 * AC#4: Audit events include authenticated agent ID
 */
export function createAuditEvent(
	keyPair: AgentKeyPair,
	action: string,
	target: string,
	details: Record<string, unknown> = {},
): AuthenticatedAuditEvent {
	const timestamp = new Date().toISOString();
	const eventId = `audit-${Date.now()}-${randomBytes(4).toString("hex")}`;

	// Create deterministic payload for signing
	const payload = JSON.stringify({
		eventId,
		timestamp,
		agentId: keyPair.agentId,
		action,
		target,
		details,
	});

	const signature = signData(keyPair.privateKey, payload);

	return {
		eventId,
		timestamp,
		agentId: keyPair.agentId,
		action,
		target,
		details,
		signature,
	};
}

/**
 * Verify an audit event's authenticity
 */
export function verifyAuditEvent(
	event: AuthenticatedAuditEvent,
	publicKey: string,
): boolean {
	const payload = JSON.stringify({
		eventId: event.eventId,
		timestamp: event.timestamp,
		agentId: event.agentId,
		action: event.action,
		target: event.target,
		details: event.details,
	});

	return verifySignature(publicKey, payload, event.signature);
}

// ===================== Identity Verification for Operations =====================

/**
 * P159: Verify a token using the DB-stored public key for the agent.
 * Falls back to token.publicKey if the DB is unavailable or the row has no key.
 * AC-5/AC-6: DB-backed lookup with graceful fallback.
 *
 * @param keyLookup - Optional override for the DB lookup (used in tests).
 *   Defaults to getAgentPublicKey from the registry.
 */
export async function verifyTokenWithDbLookup(
	token: AuthToken,
	keyLookup: (agentId: string) => Promise<string | null> = getAgentPublicKey,
): Promise<TokenVerification> {
	let publicKeyToUse = token.publicKey;

	try {
		const dbKey = await keyLookup(token.agentId);
		if (dbKey !== null) {
			publicKeyToUse = dbKey;
		}
	} catch {
		// DB unavailable — fall back to token's embedded public key
	}

	// Re-verify using the resolved public key (clone token to avoid mutation)
	const resolvedToken: AuthToken = { ...token, publicKey: publicKeyToUse };
	return verifyToken(resolvedToken);
}

/**
 * Verify that a token's agent is authorized to perform an operation
 * Returns verification result with detailed reason
 */
export function verifyOperationAuthorization(
	token: AuthToken,
	requiredAgentId?: string,
): TokenVerification {
	const tokenResult = verifyToken(token);

	if (!tokenResult.valid) {
		return tokenResult;
	}

	// Check agent match if required
	if (requiredAgentId && token.agentId !== requiredAgentId) {
		return {
			valid: false,
			agentId: token.agentId,
			reason: `Agent ${token.agentId} not authorized for ${requiredAgentId}`,
			expired: false,
		};
	}

	return tokenResult;
}

/**
 * Verify an auth token using the public key stored in agent_registry.
 *
 * Fetches the agent's public_key from the DB; falls back to token.publicKey
 * when the DB is unavailable or the agent has no recorded key.
 *
 * AC#3: Provides DB-backed verification path for MCP and orchestrator use.
 */
export async function verifyTokenWithDbLookup(
	token: AuthToken,
	lookupPublicKey: LookupPublicKeyFn = getAgentPublicKey,
): Promise<TokenVerification> {
	let publicKey = token.publicKey;

	try {
		const dbKey = await lookupPublicKey(token.agentId);
		if (dbKey) publicKey = dbKey;
	} catch {
		// DB unavailable — fall back to embedded token.publicKey
	}

	// Re-verify using the resolved public key
	const tokenWithKey: AuthToken = { ...token, publicKey };
	return verifyToken(tokenWithKey);
}
