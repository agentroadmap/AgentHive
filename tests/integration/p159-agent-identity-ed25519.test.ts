/**
 * P159: Agent Identity Verification (Ed25519 Public Key Storage)
 *
 * Asserts:
 *   AC-5: At least one agent registration flow writes a real Ed25519 public key to the DB
 *         Verifies that registerAgent() with publicKey parameter populates
 *         roadmap_workforce.agent_registry.public_key and key_rotated_at
 *   AC-6: Conflict detection — same agent_id + different public_key raises error
 *   AC-7: Soft-fail verification when public_key is NULL (backward compatibility)
 *
 * Requires: Migration 140-p159-agent-identity-ed25519.sql applied
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { closePool, getPool, query } from "../../src/infra/postgres/pool.ts";
import {
	getAgentPublicKey,
	registerAgent,
	rotateAgentPublicKey,
} from "../../src/core/identity/agent-registry/registry.ts";

// Helper to convert Ed25519 public key to hex string
function getPublicKeyHex(publicKey: any): string {
	const der = publicKey.export({ format: "der" });
	return Buffer.from(der).toString("hex");
}

const STAMP = Date.now();
const TEST_AGENT_1 = `p159-test-agent-1-${STAMP}`;
const TEST_AGENT_2 = `p159-test-agent-2-${STAMP}`;

async function cleanup() {
	try {
		await query(
			`DELETE FROM roadmap_workforce.agent_registry
			 WHERE agent_identity LIKE $1`,
			[`p159-test-agent-%`],
		);
	} catch {
		// Table might not exist yet; ignore
	}
}

describe("P159: Agent Identity Ed25519 Verification", () => {
	beforeAll(async () => {
		await cleanup();
	});

	afterEach(async () => {
		await cleanup();
	});

	afterAll(async () => {
		await cleanup();
		await closePool();
	});

	it("AC-5: registerAgent() populates public_key and key_rotated_at when provided", async () => {
		// Generate an Ed25519 keypair
		const { publicKey } = generateKeyPairSync("ed25519");
		const publicKeyHex = getPublicKeyHex(publicKey);

		// Register agent with public key
		const registered = await registerAgent({
			agentId: TEST_AGENT_1,
			agentType: "contract",
			publicKey: publicKeyHex, // P159 AC-1: Pass Ed25519 public key
		});

		expect(registered).toBeDefined();
		expect(registered.agentId).toBe(TEST_AGENT_1);

		// Query DB to verify columns were populated
		const { rows } = await query(
			`SELECT public_key, key_rotated_at, created_at
			 FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[TEST_AGENT_1],
		);

		expect(rows.length).toBe(1);
		const row = rows[0];

		// P159 AC-5: Verify public_key is stored
		expect(row.public_key).toBe(publicKeyHex);
		expect(row.public_key).toBeTruthy();

		// P159 AC-6: Verify key_rotated_at is set to current time
		expect(row.key_rotated_at).toBeDefined();
		expect(row.key_rotated_at).not.toBeNull();

		// key_rotated_at should be near created_at or now()
		const rotatedDate = new Date(row.key_rotated_at as string);
		const createdDate = new Date(row.created_at as string);
		const now = new Date();

		expect(rotatedDate.getTime()).toBeGreaterThanOrEqual(createdDate.getTime());
		expect(rotatedDate.getTime()).toBeLessThanOrEqual(now.getTime());
	});

	it("AC-5: getAgentPublicKey() retrieves public_key from DB", async () => {
		const { publicKey } = generateKeyPairSync("ed25519");
		const publicKeyHex = getPublicKeyHex(publicKey);

		// Register agent with public key
		await registerAgent({
			agentId: TEST_AGENT_2,
			agentType: "contract",
			publicKey: publicKeyHex,
		});

		// Retrieve public key using registry function
		const retrieved = await getAgentPublicKey(TEST_AGENT_2);

		expect(retrieved).toBe(publicKeyHex);
	});

	it("AC-6: Conflict detection — different public_key for same agent_id throws error", async () => {
		const { publicKey: key1 } = generateKeyPairSync("ed25519");
		const { publicKey: key2 } = generateKeyPairSync("ed25519");

		const hex1 = getPublicKeyHex(key1);
		const hex2 = getPublicKeyHex(key2);

		// Register agent with first key
		const agentId = `p159-conflict-test-${STAMP}`;
		await registerAgent({
			agentId,
			agentType: "contract",
			publicKey: hex1,
		});

		// Attempt to register same agent with different key — should throw
		let thrown = false;
		let errorMsg = "";
		try {
			await registerAgent({
				agentId,
				agentType: "contract",
				publicKey: hex2, // Different key
			});
		} catch (err) {
			thrown = true;
			errorMsg = err instanceof Error ? err.message : String(err);
		}

		expect(thrown).toBe(true);
		expect(errorMsg).toContain("conflict");
	});

	it("AC-7: Soft-fail backward compatibility — agents with NULL public_key work", async () => {
		// Register agent WITHOUT public key (backward compatibility)
		const agentId = `p159-legacy-agent-${STAMP}`;
		const registered = await registerAgent({
			agentId,
			agentType: "contract",
			// No publicKey parameter
		});

		expect(registered.agentId).toBe(agentId);

		// Query DB to verify public_key is NULL
		const { rows } = await query(
			`SELECT public_key, key_rotated_at
			 FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[agentId],
		);

		expect(rows.length).toBe(1);
		expect(rows[0].public_key).toBeNull();
		expect(rows[0].key_rotated_at).toBeNull();

		// getAgentPublicKey should return null for unsigned agents
		const retrieved = await getAgentPublicKey(agentId);
		expect(retrieved).toBeNull();
	});

	it("rotateAgentPublicKey() updates public_key and key_rotated_at", async () => {
		const { publicKey: key1 } = generateKeyPairSync("ed25519");
		const { publicKey: key2 } = generateKeyPairSync("ed25519");

		const hex1 = getPublicKeyHex(key1);
		const hex2 = getPublicKeyHex(key2);

		const agentId = `p159-rotate-test-${STAMP}`;

		// Register with first key
		await registerAgent({
			agentId,
			agentType: "contract",
			publicKey: hex1,
		});

		// Wait a tiny bit to ensure key_rotated_at timestamp differs
		await new Promise((r) => setTimeout(r, 10));

		// Get initial rotation time
		const { rows: before } = await query(
			`SELECT key_rotated_at FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[agentId],
		);
		const initialRotatedAt = before[0].key_rotated_at;

		// Rotate to second key
		await rotateAgentPublicKey(agentId, hex2);

		// Verify key and timestamp updated
		const { rows: after } = await query(
			`SELECT public_key, key_rotated_at FROM roadmap_workforce.agent_registry
			 WHERE agent_identity = $1`,
			[agentId],
		);

		expect(after[0].public_key).toBe(hex2);
		const newRotatedAt = new Date(after[0].key_rotated_at as string);
		const oldRotatedAt = new Date(initialRotatedAt as string);
		expect(newRotatedAt.getTime()).toBeGreaterThan(oldRotatedAt.getTime());
	});
});
