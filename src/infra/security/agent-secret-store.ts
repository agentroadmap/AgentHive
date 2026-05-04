/**
 * P834: Agent Secret Store with Envelope Encryption
 *
 * Manages agent secrets in the database with AES-256-GCM envelope encryption.
 * Secrets are never stored in plaintext; only ciphertext, nonce, tag, and key_version
 * are persisted. Master key lives in secrets manager (env var or external store).
 */

import { Pool } from "pg";
import crypto from "crypto";
import { encryptSecret, decryptSecret } from "./agent-crypto.ts";

/**
 * Register a new agent secret (or rotate an existing one).
 * Generates 64 random bytes (512 bits), encrypts with envelope encryption,
 * upserts into agent_secret table, and returns the plaintext secret.
 *
 * @param pool - Postgres connection pool
 * @param agentIdentity - Agent identity string
 * @returns 64-byte plaintext secret (for handoff to child agent only)
 */
export async function registerAgentSecret(
	pool: Pool,
	agentIdentity: string,
): Promise<Buffer> {
	// Generate new 512-bit secret
	const secretBytes = crypto.randomBytes(64);

	// Encrypt with envelope encryption
	const { encrypted, nonce, tag } = encryptSecret(agentIdentity, secretBytes);

	// Upsert into agent_secret table
	await pool.query(
		`INSERT INTO roadmap.agent_secret
		  (agent_identity, secret_encrypted, secret_nonce, secret_tag, key_version)
		 VALUES ($1, $2, $3, $4, 1)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   secret_encrypted = $2,
		   secret_nonce = $3,
		   secret_tag = $4,
		   rotated_at = now(),
		   rotation_due_at = now() + interval '90 days'`,
		[agentIdentity, encrypted, nonce, tag],
	);

	return secretBytes;
}

/**
 * Retrieve a plaintext agent secret from the database.
 * Reads encrypted envelope, decrypts with master key, returns plaintext or null.
 *
 * @param pool - Postgres connection pool
 * @param agentIdentity - Agent identity string
 * @returns 64-byte plaintext secret, or null if agent not found or decryption fails
 */
export async function getAgentSecret(
	pool: Pool,
	agentIdentity: string,
): Promise<Buffer | null> {
	const result = await pool.query<{
		secret_encrypted: Buffer;
		secret_nonce: Buffer;
		secret_tag: Buffer;
	}>(
		`SELECT secret_encrypted, secret_nonce, secret_tag
		 FROM roadmap.agent_secret
		 WHERE agent_identity = $1`,
		[agentIdentity],
	);

	if (result.rows.length === 0) {
		return null;
	}

	const row = result.rows[0];

	// Decrypt with envelope decryption
	const plaintext = decryptSecret(
		agentIdentity,
		row.secret_encrypted,
		row.secret_nonce,
		row.secret_tag,
	);

	if (!plaintext) {
		// Authentication failure or tampering detected
		console.error(
			`[P834] Envelope decryption failed for agent ${agentIdentity} — possible tampering`,
		);
		return null;
	}

	return plaintext;
}
