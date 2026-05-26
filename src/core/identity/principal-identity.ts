/**
 * P472 — Unified Principal Identity Model
 *
 * Single canonical identity surface for operators, agencies, and ephemeral
 * agent principals.  All cryptographic operations use node:crypto only —
 * no third-party crypto dependencies (AC#105).
 *
 * AC#100 — atomic key rotation: both old + new signatures must validate
 *           before the DB row is updated.
 * AC#101 — cache invalidated via pg_notify within 30s of revocation.
 * AC#103 — bearer tokens are bound to a principal_id; naked-bearer rejected.
 * AC#105 — clock skew tolerance ±5 min on token issue/expire.
 */

import {
	createHmac,
	timingSafeEqual,
	verify as cryptoVerify,
	type KeyObject,
	createPublicKey,
} from "node:crypto";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";

// ── Types ────────────────────────────────────────────────────────────────────

export type PrincipalKind = "operator" | "agency" | "agent";
export type CredentialKind = "oauth" | "ed25519" | "hmac_session";

export interface PrincipalIdentity {
	principal_id: string;
	principal_kind: PrincipalKind;
	parent_principal_id: string | null;
	credential_kind: CredentialKind;
	public_credential: string | null;
	issued_at: Date;
	expires_at: Date | null;
	revoked_at: Date | null;
	revocation_reason: string | null;
	last_used_at: Date | null;
	metadata: Record<string, unknown>;
}

/** Payload embedded in every bearer token (AC#103 — bound to principal_id). */
export interface BoundBearerPayload {
	/** 'rmk_p472' prefix identifies P472-issued tokens */
	prefix: "rmk_p472";
	principal_id: string;
	issued_at: number; // Unix ms
	expires_at: number; // Unix ms
	nonce: string; // 16 hex chars
}

/** Wire format: base64url(JSON payload) + "." + base64url(signature) */
export type BoundBearerToken = string;

/** Request carrying the bound bearer token */
export interface AuthenticatedRequest {
	principal_id: string;
	bearer_token: BoundBearerToken;
}

export interface KeyRotationRequest {
	principal_id: string;
	/** New Ed25519 public key PEM */
	new_public_key: string;
	/**
	 * Signature of new_public_key bytes signed with the OLD private key.
	 * Proves the rotation requester still controls the old key (AC#100).
	 */
	old_key_signature_of_new: string; // base64
	/**
	 * Signature of old_public_key bytes (currently on record) signed with NEW key.
	 * Proves the requester already controls the new key (AC#100).
	 */
	new_key_signature_of_old: string; // base64
}

export interface AgentSessionTokenInput {
	/** agency private key PEM — used to derive the HMAC (AC#105) */
	agency_private_key_pem: string;
	agent_identity: string;
	spawn_briefing_id: string;
	spawn_started_at: Date;
	/** P842: Optional budget scope embedded in token for fast-path enforcement */
	budget_scope?: {
		max_spend_usd: number;
		period: 'day' | 'week' | 'month' | 'total';
		reset_at_utc_hour?: number;
	};
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Clock skew window — tokens are valid if within ±5 min (AC#105) */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Default bearer token TTL for operator sessions */
export const OPERATOR_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** pg_notify channel emitted on revocation (AC#101) */
export const REVOCATION_NOTIFY_CHANNEL = "principal_revoked";

/** Cache TTL — keys older than this are considered stale (AC#101: ≤30s) */
const CACHE_TTL_MS = 25_000; // 25 s  ← safely within the 30s requirement

// ── In-process principal cache ───────────────────────────────────────────────

interface CacheEntry {
	principal: PrincipalIdentity;
	cached_at: number;
}

/**
 * Principal identity store backed by `roadmap.principal_identity`.
 *
 * Maintains a short-lived in-process cache with pg_notify invalidation so
 * revoked principals are flushed within the 30-second window (AC#101).
 */
export class PrincipalIdentityStore extends EventEmitter {
	private readonly pool: Pool;
	private readonly cache = new Map<string, CacheEntry>();
	private notifyClient: PoolClient | null = null;

	constructor(pool: Pool) {
		super();
		this.pool = pool;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	/** Subscribe to pg_notify for revocation cascades (AC#101). */
	async startRevocationListener(): Promise<void> {
		if (this.notifyClient) return;
		try {
			this.notifyClient = await this.pool.connect();
			await this.notifyClient.query(
				`LISTEN ${REVOCATION_NOTIFY_CHANNEL}`,
			);
			this.notifyClient.on("notification", (msg) => {
				if (msg.channel !== REVOCATION_NOTIFY_CHANNEL) return;
				try {
					const payload = JSON.parse(msg.payload ?? "{}") as {
						principal_id?: string;
						kind?: string;
					};
					if (payload.principal_id) {
						// Flush the revoked principal and all cached descendants
						this._flushCascade(payload.principal_id);
						this.emit("revoked", payload.principal_id);
					}
				} catch {
					// Malformed notify payload — safe to ignore
				}
			});
		} catch {
			// Non-fatal: cache falls back to TTL-based expiry (≤30s)
		}
	}

	/** Release the notify subscription. */
	async stop(): Promise<void> {
		if (this.notifyClient) {
			try {
				await this.notifyClient.query(
					`UNLISTEN ${REVOCATION_NOTIFY_CHANNEL}`,
				);
			} finally {
				this.notifyClient.release();
				this.notifyClient = null;
			}
		}
	}

	// ── Read ──────────────────────────────────────────────────────────────────

	/** Look up a principal, using the cache when the entry is fresh. */
	async get(principalId: string): Promise<PrincipalIdentity | null> {
		const now = Date.now();
		const cached = this.cache.get(principalId);
		if (cached && now - cached.cached_at < CACHE_TTL_MS) {
			return cached.principal;
		}

		const result = await this.pool.query<PrincipalIdentity>(
			`SELECT * FROM roadmap.principal_identity WHERE principal_id = $1`,
			[principalId],
		);
		if (result.rows.length === 0) return null;
		const principal = result.rows[0];
		this.cache.set(principalId, { principal, cached_at: now });
		return principal;
	}

	/** Returns true when the principal exists and is currently valid. */
	async isActive(principalId: string): Promise<boolean> {
		const p = await this.get(principalId);
		if (!p) return false;
		if (p.revoked_at) return false;
		if (p.expires_at && p.expires_at.getTime() < Date.now()) return false;
		return true;
	}

	// ── Write ─────────────────────────────────────────────────────────────────

	/** Upsert a principal row (used by OAuth issuance and liaison registration). */
	async upsert(
		principal: Omit<PrincipalIdentity, "issued_at" | "last_used_at">,
	): Promise<void> {
		await this.pool.query(
			`INSERT INTO roadmap.principal_identity
			   (principal_id, principal_kind, parent_principal_id, credential_kind,
			    public_credential, expires_at, revoked_at, revocation_reason, metadata)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			 ON CONFLICT (principal_id) DO UPDATE SET
			   public_credential  = EXCLUDED.public_credential,
			   expires_at         = EXCLUDED.expires_at,
			   revoked_at         = EXCLUDED.revoked_at,
			   revocation_reason  = EXCLUDED.revocation_reason,
			   metadata           = EXCLUDED.metadata`,
			[
				principal.principal_id,
				principal.principal_kind,
				principal.parent_principal_id,
				principal.credential_kind,
				principal.public_credential,
				principal.expires_at,
				principal.revoked_at,
				principal.revocation_reason,
				JSON.stringify(principal.metadata),
			],
		);
		this.cache.delete(principal.principal_id);
	}

	/**
	 * Touch last_used_at (non-blocking fire-and-forget; failures are non-fatal).
	 */
	touchLastUsed(principalId: string): void {
		this.pool
			.query(
				`UPDATE roadmap.principal_identity
			   SET last_used_at = now()
			 WHERE principal_id = $1`,
				[principalId],
			)
			.catch(() => {
				/* non-fatal */
			});
	}

	// ── Key rotation (AC#100) ─────────────────────────────────────────────────

	/**
	 * Atomically rotate an agency Ed25519 key.
	 *
	 * Both old-key-signs-new AND new-key-signs-old must validate before the DB
	 * row is updated (AC#100: proof-of-possession of both keys).
	 */
	async rotateAgencyKey(req: KeyRotationRequest): Promise<void> {
		const principal = await this.get(req.principal_id);
		if (!principal) throw new Error(`principal not found: ${req.principal_id}`);
		if (principal.principal_kind !== "agency")
			throw new Error(`key rotation only supported for agency principals`);
		if (principal.revoked_at)
			throw new Error(`cannot rotate key on revoked principal`);
		const oldPublicKeyPem = principal.public_credential;
		if (!oldPublicKeyPem)
			throw new Error(`principal has no registered public key`);

		// Verify: old key signed new_public_key
		_verifyEd25519OrThrow(
			oldPublicKeyPem,
			Buffer.from(req.new_public_key),
			req.old_key_signature_of_new,
			"old_key_signature_of_new",
		);

		// Verify: new key signed old_public_key
		_verifyEd25519OrThrow(
			req.new_public_key,
			Buffer.from(oldPublicKeyPem),
			req.new_key_signature_of_old,
			"new_key_signature_of_old",
		);

		// Both proofs passed — update atomically
		await this.pool.query(
			`UPDATE roadmap.principal_identity
			    SET public_credential = $2,
			        metadata = metadata || $3::jsonb
			  WHERE principal_id = $1
			    AND revoked_at IS NULL`,
			[
				req.principal_id,
				req.new_public_key,
				JSON.stringify({
					key_rotated_at: new Date().toISOString(),
					previous_public_key_fingerprint: _pubkeyFingerprint(oldPublicKeyPem),
				}),
			],
		);
		this.cache.delete(req.principal_id);
	}

	// ── Revocation ────────────────────────────────────────────────────────────

	/** Revoke a principal (and cascade to its children via DB trigger). */
	async revoke(principalId: string, reason: string): Promise<void> {
		await this.pool.query(
			`UPDATE roadmap.principal_identity
			    SET revoked_at        = now(),
			        revocation_reason = $2
			  WHERE principal_id = $1
			    AND revoked_at IS NULL`,
			[principalId, reason],
		);
		this._flushCascade(principalId);
	}

	// ── Cache helpers ─────────────────────────────────────────────────────────

	private _flushCascade(principalId: string): void {
		this.cache.delete(principalId);
		// Also flush any cached children
		for (const [id, entry] of this.cache) {
			if (entry.principal.parent_principal_id === principalId) {
				this.cache.delete(id);
			}
		}
	}
}

// ── Bearer token issuance and verification (AC#103) ──────────────────────────

/**
 * Issue a bearer token bound to a principal_id.
 *
 * Token payload includes principal_id so naked-bearer (no principal_id) is
 * structurally impossible; the verifier enforces the binding (AC#103).
 *
 * Clock skew tolerance of ±CLOCK_SKEW_MS applied on verification (AC#105).
 */
export function issueBoundBearer(
	principalId: string,
	hmacSecret: Buffer,
	ttlMs = OPERATOR_TOKEN_TTL_MS,
): BoundBearerToken {
	const now = Date.now();
	const payload: BoundBearerPayload = {
		prefix: "rmk_p472",
		principal_id: principalId,
		issued_at: now,
		expires_at: now + ttlMs,
		nonce: randomHex(8),
	};
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const sig = createHmac("sha256", hmacSecret).update(payloadB64).digest("base64url");
	return `${payloadB64}.${sig}`;
}

export interface VerifyBearerResult {
	ok: boolean;
	principal_id?: string;
	reason?: string;
}

/**
 * Verify a bound bearer token.
 *
 * Rejects:
 *  - tokens without an embedded principal_id (AC#103 — naked-bearer)
 *  - expired tokens (with ±CLOCK_SKEW_MS tolerance) (AC#105)
 *  - HMAC mismatches
 */
export function verifyBoundBearer(
	token: BoundBearerToken,
	hmacSecret: Buffer,
): VerifyBearerResult {
	const parts = token.split(".");
	if (parts.length !== 2) return { ok: false, reason: "malformed_token" };
	const [payloadB64, sigB64] = parts;

	// Constant-time HMAC check
	const expected = createHmac("sha256", hmacSecret)
		.update(payloadB64)
		.digest("base64url");
	if (
		expected.length !== sigB64.length ||
		!timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64))
	) {
		return { ok: false, reason: "invalid_signature" };
	}

	let payload: BoundBearerPayload;
	try {
		payload = JSON.parse(
			Buffer.from(payloadB64, "base64url").toString(),
		) as BoundBearerPayload;
	} catch {
		return { ok: false, reason: "malformed_payload" };
	}

	if (payload.prefix !== "rmk_p472")
		return { ok: false, reason: "wrong_token_prefix" };

	// AC#103 — reject naked-bearer (no principal_id binding)
	if (!payload.principal_id)
		return { ok: false, reason: "missing_principal_id_binding" };

	const now = Date.now();
	// AC#105 — clock skew tolerance
	if (now > payload.expires_at + CLOCK_SKEW_MS)
		return { ok: false, reason: "token_expired" };
	if (now < payload.issued_at - CLOCK_SKEW_MS)
		return { ok: false, reason: "token_not_yet_valid" };

	return { ok: true, principal_id: payload.principal_id };
}

// ── Agent HMAC session token derivation ──────────────────────────────────────

/**
 * Derive a deterministic HMAC session token for an ephemeral agent.
 *
 * HMAC(agency_private_key_raw, agent_identity|spawn_briefing_id|spawn_started_at_iso)
 *
 * Same inputs always produce the same token; the orchestrator can verify
 * without storing the token — it re-derives and compares (AC#105).
 */
export function deriveAgentSessionToken(
	input: AgentSessionTokenInput,
): string {
	const message = [
		input.agent_identity,
		input.spawn_briefing_id,
		input.spawn_started_at.toISOString(),
	].join("|");

	// Use the raw private key bytes as HMAC key.
	// We extract the DER payload from the PEM to get stable bytes.
	const privKeyObj = _importPrivateKeyBytes(input.agency_private_key_pem);
	return createHmac("sha256", privKeyObj).update(message).digest("base64url");
}

/**
 * Verify an agent session token by re-deriving it from the same inputs.
 * Returns true if the presented token matches the derived token.
 */
export function verifyAgentSessionToken(
	presented: string,
	input: AgentSessionTokenInput,
): boolean {
	const expected = deriveAgentSessionToken(input);
	if (expected.length !== presented.length) return false;
	return timingSafeEqual(
		Buffer.from(expected, "base64url"),
		Buffer.from(presented, "base64url"),
	);
}

// ── Ed25519 helpers ───────────────────────────────────────────────────────────

function _verifyEd25519OrThrow(
	publicKeyPem: string,
	message: Buffer,
	signatureB64: string,
	label: string,
): void {
	let keyObj: KeyObject;
	try {
		keyObj = createPublicKey({ key: publicKeyPem, format: "pem" });
	} catch {
		throw new Error(`${label}: cannot parse public key PEM`);
	}
	const sigBuf = Buffer.from(signatureB64, "base64");
	// Ed25519 uses null algorithm — algorithm is intrinsic to the key type
	const valid = cryptoVerify(null, message, keyObj, sigBuf);
	if (!valid) throw new Error(`${label}: signature verification failed (AC#100)`);
}

function _pubkeyFingerprint(publicKeyPem: string): string {
	return createHmac("sha256", "fingerprint")
		.update(publicKeyPem)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Extract raw private key bytes from a PKCS#8 PEM for use as HMAC key.
 * Uses only node:crypto — no custom crypto (AC#105).
 */
function _importPrivateKeyBytes(pem: string): Buffer {
	// Strip PEM header/footer and decode base64 to DER
	const b64 = pem
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s/g, "");
	return Buffer.from(b64, "base64");
}

function randomHex(bytes: number): string {
	const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
	return randomBytes(bytes).toString("hex");
}
