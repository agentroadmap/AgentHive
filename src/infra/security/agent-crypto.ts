/**
 * P834: Cryptographic Identity Services for A2A Messages
 *
 * Uses Node.js built-in crypto module (no external dependencies).
 * Implements:
 * 1. Envelope encryption (AES-256-GCM) with external master key
 * 2. HKDF-SHA256 key derivation (RFC 5869) with full context binding
 * 3. HMAC-SHA256 signing with constant-time verification
 */

import crypto from "crypto";

/**
 * Get the master encryption key from environment.
 * Expects AGENT_MASTER_KEY env var as hex-encoded 32 bytes (256 bits).
 * Falls back to random key with WARNING if not set (dev only).
 */
function getMasterKey(): Buffer {
	const masterKeyHex = process.env.AGENT_MASTER_KEY;

	if (!masterKeyHex) {
		console.warn(
			"⚠️ AGENT_MASTER_KEY not set. Generating random master key for development only.",
		);
		return crypto.randomBytes(32);
	}

	const keyBuffer = Buffer.from(masterKeyHex, "hex");
	if (keyBuffer.length !== 32) {
		throw new Error(
			`AGENT_MASTER_KEY must be 32 bytes (256 bits), got ${keyBuffer.length}`,
		);
	}
	return keyBuffer;
}

/**
 * Encrypt an agent secret using AES-256-GCM with external master key.
 * AAD (Additional Authenticated Data) = agent_identity (prevents transplant attacks).
 *
 * @returns { encrypted: Buffer, nonce: Buffer, tag: Buffer }
 */
export function encryptSecret(
	agentIdentity: string,
	secretBytes: Buffer,
): { encrypted: Buffer; nonce: Buffer; tag: Buffer } {
	if (secretBytes.length !== 64) {
		throw new Error(
			`Agent secret must be 64 bytes (512 bits), got ${secretBytes.length}`,
		);
	}

	const masterKey = getMasterKey();
	const nonce = crypto.randomBytes(12); // 96-bit nonce for GCM
	const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, nonce);

	// Set AAD to agent_identity for transplant attack prevention
	cipher.setAAD(Buffer.from(agentIdentity, "utf-8"));

	let encrypted = cipher.update(secretBytes);
	encrypted = Buffer.concat([encrypted, cipher.final()]);

	const tag = cipher.getAuthTag();

	return { encrypted, nonce, tag };
}

/**
 * Decrypt an agent secret using AES-256-GCM with external master key.
 * Verifies GCM tag; returns null on authentication failure.
 *
 * @returns Plaintext secret Buffer, or null if authentication fails
 */
export function decryptSecret(
	agentIdentity: string,
	encrypted: Buffer,
	nonce: Buffer,
	tag: Buffer,
): Buffer | null {
	if (nonce.length !== 12) {
		throw new Error(`Nonce must be 12 bytes, got ${nonce.length}`);
	}
	if (tag.length !== 16) {
		throw new Error(`Tag must be 16 bytes, got ${tag.length}`);
	}

	try {
		const masterKey = getMasterKey();
		const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);

		// Set AAD to match encryption
		decipher.setAAD(Buffer.from(agentIdentity, "utf-8"));

		// Set authentication tag before final()
		decipher.setAuthTag(tag);

		let decrypted = decipher.update(encrypted);
		decrypted = Buffer.concat([decrypted, decipher.final()]);

		return decrypted;
	} catch (err) {
		// Authentication failure or decryption error
		return null;
	}
}

/**
 * RFC 5869 HKDF-SHA256 with full context binding.
 * Derives a unique 256-bit signing key per message context.
 *
 * @param agentSecret - 512-bit plaintext secret (decrypted from envelope)
 * @param fromAgent - Sender agent identity
 * @param toAgent - Recipient agent identity (empty string for broadcast)
 * @param messageType - Type of message (e.g., 'task', 'directive')
 * @param createdAtEpoch - Message creation timestamp (seconds since epoch)
 * @param salt - Optional salt (if not provided, deterministic salt = sha256(fromAgent|toAgent))
 *
 * @returns 256-bit derived key
 */
export function deriveSigningKey(
	agentSecret: Buffer,
	fromAgent: string,
	toAgent: string,
	messageType: string,
	createdAtEpoch: number,
	salt?: Buffer,
): Buffer {
	// Deterministic salt from agent identities if not provided
	let derivedSalt = salt;
	if (!derivedSalt) {
		const saltInput = `${fromAgent}|${toAgent}`;
		derivedSalt = crypto
			.createHash("sha256")
			.update(saltInput, "utf-8")
			.digest();
	}

	// Time window at minute granularity
	const timeWindowMinute = Math.floor(createdAtEpoch / 60);

	// Full context binding in info parameter
	const info = `${fromAgent}|${toAgent}|${messageType}|${timeWindowMinute}`;

	// RFC 5869 HKDF-SHA256
	// length=32 for 256-bit output (suitable for HMAC-SHA256 key)
	const derived = crypto.hkdfSync(
		"sha256",
		agentSecret,
		derivedSalt,
		info,
		32,
	);

	return Buffer.from(derived);
}

/**
 * Sign a message using HMAC-SHA256 with RFC 5869-derived signing key.
 *
 * @param agentSecret - 512-bit plaintext secret
 * @param fromAgent - Sender identity
 * @param toAgent - Recipient identity
 * @param messageType - Message type
 * @param createdAtEpoch - Message creation timestamp
 * @param payloadSha256 - SHA256 hash of message payload
 * @param salt - Optional salt (same as deriveSigningKey)
 *
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function signMessage(
	agentSecret: Buffer,
	fromAgent: string,
	toAgent: string,
	messageType: string,
	createdAtEpoch: number,
	payloadSha256: Buffer,
	salt?: Buffer,
): string {
	// Derive signing key using same context
	const derivedKey = deriveSigningKey(
		agentSecret,
		fromAgent,
		toAgent,
		messageType,
		createdAtEpoch,
		salt,
	);

	// Construct HMAC input with full context
	const hmacInput = `${fromAgent}|${toAgent}|${messageType}|${createdAtEpoch}|${payloadSha256.toString("hex")}`;

	// HMAC-SHA256
	const signature = crypto
		.createHmac("sha256", derivedKey)
		.update(hmacInput, "utf-8")
		.digest();

	return signature.toString("hex");
}

/**
 * Verify a message signature using constant-time comparison.
 *
 * @param agentSecret - 512-bit plaintext secret (from sender)
 * @param fromAgent - Sender identity
 * @param toAgent - Recipient identity
 * @param messageType - Message type
 * @param createdAtEpoch - Message creation timestamp
 * @param payloadSha256 - SHA256 hash of message payload
 * @param providedSigHex - Hex-encoded signature to verify
 * @param salt - Optional salt (must match signing)
 *
 * @returns true if signature is valid, false otherwise
 */
export function verifySignature(
	agentSecret: Buffer,
	fromAgent: string,
	toAgent: string,
	messageType: string,
	createdAtEpoch: number,
	payloadSha256: Buffer,
	providedSigHex: string,
	salt?: Buffer,
): boolean {
	try {
		// Compute expected signature
		const expectedSig = signMessage(
			agentSecret,
			fromAgent,
			toAgent,
			messageType,
			createdAtEpoch,
			payloadSha256,
			salt,
		);

		// Constant-time comparison prevents timing attacks
		return crypto.timingSafeEqual(
			Buffer.from(expectedSig, "hex"),
			Buffer.from(providedSigHex, "hex"),
		);
	} catch {
		// On any error (invalid hex, buffer size mismatch), signature is invalid
		return false;
	}
}
