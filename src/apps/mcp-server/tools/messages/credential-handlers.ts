/**
 * P834: Credential Bootstrap Handlers
 *
 * Manages the ECDH-based credential delivery protocol for spawned agents.
 * Uses in-memory spawn_bucket with 15-minute TTL for ephemeral state.
 *
 * Phase 2: agent_credential_claim — child claims credential grant
 * Phase 3: agent_credential_deliver — parent delivers encrypted credential
 */

import crypto from "crypto";
import type { CallToolResult } from "../../types.ts";

/**
 * Spawn bucket entry: ephemeral state for one spawn grant.
 */
interface SpawnEntry {
	parent_identity: string;
	child_identity: string;
	agency_id: string;
	allowed_scopes: string[];
	denied_scopes?: string[];
	max_spawn_depth?: number;
	grant_expires_at: string;
	nonce: string;
	parent_sig: string;
	child_ephemeral_public_key?: string; // Set when child claims
	parent_ephemeral_private_key?: string; // Wrapped in production
	claimed_at?: number;
	created_at: number;
	credential_envelope?: {
		nonce: string;
		grant_expires_at: string;
		child_agent_secret_encrypted: string;
		encryption_nonce: string;
		encryption_tag: string;
	};
}

/**
 * In-memory spawn bucket with 15-minute TTL.
 * In production, use Redis or Memcached.
 */
const spawnBucket = new Map<string, SpawnEntry>();

/**
 * Cleanup stale entries every 5 minutes.
 */
const SPAWN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
	const now = Date.now();
	let cleaned = 0;
	for (const [key, entry] of spawnBucket.entries()) {
		if (now - entry.created_at > SPAWN_TTL_MS) {
			spawnBucket.delete(key);
			cleaned++;
		}
	}
	if (cleaned > 0) {
		console.log(`[P834] Cleaned ${cleaned} expired spawn bucket entries`);
	}
}, CLEANUP_INTERVAL_MS);

function errorResult(msg: string, err?: unknown): CallToolResult {
	const errMsg = err instanceof Error ? err.message : String(err);
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}${errMsg ? ": " + errMsg : ""}`,
			},
		],
	};
}

/**
 * Create a spawn manifest and store in spawn_bucket.
 * Called by orchestrator before spawning a child agent.
 *
 * @param parentIdentity - Parent agent identity
 * @param childIdentity - Child agent identity
 * @param agencyId - Agency context
 * @param allowedScopes - Scopes granted to child
 * @param deniedScopes - Scopes explicitly denied
 * @param maxSpawnDepth - Max nesting depth for child's spawns
 * @param parentEphemeralPublicKey - Parent's ephemeral ECDH public key (hex)
 * @param parentSig - HMAC signature of manifest (parent signs with agent_secret)
 *
 * @returns Spawn manifest object with nonce
 */
export function spawnManifestCreate(args: {
	parent_identity: string;
	child_identity: string;
	agency_id: string;
	allowed_scopes: string[];
	denied_scopes?: string[];
	max_spawn_depth?: number;
	parent_ephemeral_public_key: string;
	parent_sig: string;
}): { manifest: SpawnEntry; nonce: string } | { error: string } {
	try {
		// Generate unique 256-bit nonce
		const nonce = crypto.randomBytes(32).toString("hex");

		const now = Date.now();
		const grantExpiresAt = new Date(now + 15 * 60 * 1000).toISOString(); // 15 min from now

		const entry: SpawnEntry = {
			parent_identity: args.parent_identity,
			child_identity: args.child_identity,
			agency_id: args.agency_id,
			allowed_scopes: args.allowed_scopes,
			denied_scopes: args.denied_scopes,
			max_spawn_depth: args.max_spawn_depth ?? 2,
			grant_expires_at: grantExpiresAt,
			nonce,
			parent_sig: args.parent_sig,
			parent_ephemeral_private_key: undefined, // Set separately
			created_at: now,
		};

		// Store in spawn bucket with TTL
		spawnBucket.set(`spawn:${nonce}`, entry);

		// Return manifest (public fields)
		return {
			manifest: entry,
			nonce,
		};
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

/**
 * Phase 2: Child claims credential grant.
 * Atomically validates nonce exists and sets child's ephemeral public key.
 * Rejects if nonce already claimed (single-use enforcement).
 *
 * @param nonce - 256-bit hex nonce from spawn manifest
 * @param childEphemeralPublicKey - Child's ephemeral ECDH public key (hex)
 * @param childIdentity - Child agent identity (must match spawn manifest)
 *
 * @returns { claimed: true, nonce_confirmed } or error
 */
export function agentCredentialClaim(args: {
	nonce: string;
	child_ephemeral_public_key: string;
	child_identity: string;
}): CallToolResult {
	try {
		const key = `spawn:${args.nonce}`;
		const entry = spawnBucket.get(key);

		if (!entry) {
			return errorResult("NONCE_NOT_FOUND", new Error("Spawn nonce not found or expired"));
		}

		// IMP-2A: Single-use enforcement
		if (entry.claimed_at) {
			return errorResult(
				"NONCE_ALREADY_CLAIMED",
				new Error(`Nonce already claimed at ${new Date(entry.claimed_at).toISOString()}`),
			);
		}

		// IMP-2A: Validate child_identity matches manifest
		if (entry.child_identity !== args.child_identity) {
			return errorResult(
				"CHILD_IDENTITY_MISMATCH",
				new Error(
					`Child identity mismatch: manifest says ${entry.child_identity}, claim says ${args.child_identity}`,
				),
			);
		}

		// Atomically mark as claimed and store child's ephemeral public key
		entry.child_ephemeral_public_key = args.child_ephemeral_public_key;
		entry.claimed_at = Date.now();

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						claimed: true,
						nonce_confirmed: args.nonce,
						child_identity: args.child_identity,
					}),
				},
			],
		};
	} catch (err) {
		return errorResult("CREDENTIAL_CLAIM_FAILED", err);
	}
}

/**
 * Phase 3: Orchestrator delivers encrypted credential.
 * Retrieves child's ephemeral public key from spawn_bucket,
 * completes ECDH, derives session key, encrypts child's agent_secret,
 * and notifies child via pg_notify.
 *
 * @param nonce - Spawn nonce
 * @param childAgentSecretEncrypted - AES-256-GCM ciphertext of child's agent_secret (hex)
 * @param encryptionNonce - 96-bit nonce used in encryption (hex)
 * @param encryptionTag - GCM authentication tag (hex)
 * @param grantExpiresAt - ISO8601 timestamp when grant expires
 *
 * @returns { delivered: true } or error
 */
export function agentCredentialDeliver(args: {
	nonce: string;
	child_agent_secret_encrypted: string;
	encryption_nonce: string;
	encryption_tag: string;
	grant_expires_at: string;
}): CallToolResult {
	try {
		const key = `spawn:${args.nonce}`;
		const entry = spawnBucket.get(key);

		if (!entry) {
			return errorResult("SPAWN_ENTRY_NOT_FOUND", new Error("Spawn manifest not found"));
		}

		if (!entry.claimed_at) {
			return errorResult(
				"CREDENTIAL_NOT_CLAIMED",
				new Error("Child has not yet claimed credential (call agent_credential_claim first)"),
			);
		}

		if (!entry.child_ephemeral_public_key) {
			return errorResult(
				"CHILD_PUBLIC_KEY_MISSING",
				new Error("Child's ephemeral public key not found"),
			);
		}

		// In production, this would:
		// 1. Perform ECDH key agreement with entry.parent_ephemeral_private_key and entry.child_ephemeral_public_key
		// 2. Derive session key via HKDF-SHA256
		// 3. Verify credential matches (ciphertext should decrypt with session key)
		// 4. Deliver via pg_notify: `credential:${childIdentity}`
		//
		// For now, we store the credential envelope in spawn_bucket and return success.
		// The child can retrieve it via a separate endpoint or pg_notify polling.

		entry.credential_envelope = {
			nonce: args.nonce,
			grant_expires_at: args.grant_expires_at,
			child_agent_secret_encrypted: args.child_agent_secret_encrypted,
			encryption_nonce: args.encryption_nonce,
			encryption_tag: args.encryption_tag,
		};

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						delivered: true,
						nonce: args.nonce,
						child_identity: entry.child_identity,
					}),
				},
			],
		};
	} catch (err) {
		return errorResult("CREDENTIAL_DELIVER_FAILED", err);
	}
}

/**
 * Retrieve stored credential envelope (for testing/debugging).
 * In production, child would receive this via pg_notify callback.
 */
export function agentCredentialRetrieve(args: { nonce: string }): CallToolResult {
	try {
		const key = `spawn:${args.nonce}`;
		const entry = spawnBucket.get(key);

		if (!entry) {
			return errorResult("SPAWN_ENTRY_NOT_FOUND", new Error("Spawn entry not found"));
		}

		if (!entry.credential_envelope) {
			return errorResult(
				"CREDENTIAL_NOT_DELIVERED",
				new Error("Credential has not yet been delivered"),
			);
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(entry.credential_envelope),
				},
			],
		};
	} catch (err) {
		return errorResult("CREDENTIAL_RETRIEVE_FAILED", err);
	}
}
