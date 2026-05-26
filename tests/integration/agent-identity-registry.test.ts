/**
 * P159 — agent-identity.ts ↔ agent_registry wiring.
 *
 * These tests keep Postgres out of the loop and verify the contract at the
 * identity/registry boundary: exact registration payloads, restart backfill,
 * rotation propagation, DB-backed token verification, and key conflict rules.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AgentKeyPair,
	getOrCreateIdentity,
	issueToken,
	loadKeyPair,
	rotateKeyPair,
	verifyToken,
	verifyTokenWithDbLookup,
} from "../../src/core/identity/agent-identity.ts";
import {
	assertNoPublicKeyConflict,
	type RegistrationRequest,
} from "../../src/core/identity/agent-registry/index.ts";

function genKeyPair() {
	return generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
}

function fakeRegistrationResponse(request: RegistrationRequest) {
	return {
		success: true,
		agentId: request.instanceId ?? request.agentId,
		channel: request.channel ?? `agent-${request.agentId}`,
		message: "registered",
	};
}

describe("P159 identity registry sync", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "p159-identity-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("registers a newly created identity under the keypair agentId with publicKey", async () => {
		const calls: RegistrationRequest[] = [];
		const keyPair = await getOrCreateIdentity(tmpDir, "p159-new-agent", {
			registerIdentity: async (request) => {
				calls.push(request);
				return fakeRegistrationResponse(request);
			},
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].agentId, keyPair.agentId);
		assert.equal(
			calls[0].instanceId,
			keyPair.agentId,
			"registry row must use the stable keypair agentId, not an auto-suffixed contract id",
		);
		assert.equal(calls[0].publicKey, keyPair.publicKey);
	});

	it("backfills an existing on-disk identity on subsequent startup", async () => {
		const calls: RegistrationRequest[] = [];
		const registerIdentity = async (request: RegistrationRequest) => {
			calls.push(request);
			return fakeRegistrationResponse(request);
		};

		const first = await getOrCreateIdentity(tmpDir, "p159-backfill-agent", {
			registerIdentity,
		});
		const second = await getOrCreateIdentity(tmpDir, "p159-backfill-agent", {
			registerIdentity,
		});

		assert.equal(first.agentId, second.agentId);
		assert.equal(first.publicKey, second.publicKey);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].instanceId, first.agentId);
		assert.equal(calls[1].publicKey, first.publicKey);
	});

	it("keeps the file-system identity authoritative when registry sync fails", async () => {
		const keyPair = await getOrCreateIdentity(tmpDir, "p159-db-down-agent", {
			registerIdentity: async () => {
				throw new Error("db unavailable");
			},
		});

		const onDisk = await loadKeyPair(tmpDir, keyPair.agentId);
		assert.equal(onDisk?.publicKey, keyPair.publicKey);
	});

	it("updates agent_registry public_key on rotation after persisting the new key", async () => {
		const original = await getOrCreateIdentity(tmpDir, "p159-rotate-agent", {
			registerIdentity: async (request) => fakeRegistrationResponse(request),
		});
		const updates: Array<{ agentId: string; publicKey: string }> = [];

		const { newKeyPair, previousPublicKey } = await rotateKeyPair(
			tmpDir,
			original,
			{
				updatePublicKey: async (agentId, publicKey) => {
					updates.push({ agentId, publicKey });
				},
			},
		);

		const onDisk = await loadKeyPair(tmpDir, original.agentId);
		assert.equal(previousPublicKey, original.publicKey);
		assert.notEqual(newKeyPair.publicKey, original.publicKey);
		assert.equal(onDisk?.publicKey, newKeyPair.publicKey);
		assert.deepEqual(updates, [
			{ agentId: original.agentId, publicKey: newKeyPair.publicKey },
		]);
	});

	it("does not fail rotation if registry key update is unavailable", async () => {
		const original = await getOrCreateIdentity(tmpDir, "p159-rotate-db-down", {
			registerIdentity: async (request) => fakeRegistrationResponse(request),
		});

		const { newKeyPair } = await rotateKeyPair(tmpDir, original, {
			updatePublicKey: async () => {
				throw new Error("db unavailable");
			},
		});

		assert.equal(newKeyPair.version, original.version + 1);
		assert.equal(
			(await loadKeyPair(tmpDir, original.agentId))?.publicKey,
			newKeyPair.publicKey,
		);
	});

	it("uses the DB public key instead of the token-embedded key when present", async () => {
		const signingKeys = genKeyPair();
		const wrongKeys = genKeyPair();
		const keyPair: AgentKeyPair = {
			agentId: "agent-p159-db-lookup",
			publicKey: signingKeys.publicKey,
			privateKey: signingKeys.privateKey,
			created: new Date().toISOString(),
			version: 1,
		};
		const token = issueToken(keyPair);
		const tamperedToken = { ...token, publicKey: wrongKeys.publicKey };

		assert.equal(verifyToken(tamperedToken).valid, false);

		const result = await verifyTokenWithDbLookup(
			tamperedToken,
			async (agentId) => {
				assert.equal(agentId, keyPair.agentId);
				return keyPair.publicKey;
			},
		);

		assert.equal(result.valid, true);
		assert.equal(result.agentId, keyPair.agentId);
	});

	it("falls back to token.publicKey when registry lookup misses or fails", async () => {
		const keys = genKeyPair();
		const keyPair: AgentKeyPair = {
			agentId: "agent-p159-fallback",
			publicKey: keys.publicKey,
			privateKey: keys.privateKey,
			created: new Date().toISOString(),
			version: 1,
		};
		const token = issueToken(keyPair);

		assert.equal(
			(await verifyTokenWithDbLookup(token, async () => null)).valid,
			true,
		);
		assert.equal(
			(
				await verifyTokenWithDbLookup(token, async () => {
					throw new Error("db unavailable");
				})
			).valid,
			true,
		);
	});
});

describe("P159 public key conflict rule", () => {
	it("allows matching keys and empty existing keys", () => {
		assert.doesNotThrow(() => assertNoPublicKeyConflict("agent-a", null, "pk"));
		assert.doesNotThrow(() =>
			assertNoPublicKeyConflict("agent-a", undefined, "pk"),
		);
		assert.doesNotThrow(() => assertNoPublicKeyConflict("agent-a", "pk", "pk"));
	});

	it("rejects implicit key replacement and directs callers to rotateKeyPair()", () => {
		assert.throws(
			() => assertNoPublicKeyConflict("agent-a", "old-pk", "new-pk"),
			/Key conflict for agent agent-a: registered public_key differs from provided key\. Use rotateKeyPair\(\) to explicitly rotate\./,
		);
	});
});
