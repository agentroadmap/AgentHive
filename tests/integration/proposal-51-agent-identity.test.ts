/**
 * proposal-51: Agent Identity Authentication Protocol - Test Suite
 *
 * Tests all 5 acceptance criteria:
 * AC#1: Agent identity keys generated on first run
 * AC#2: Token issuance via daemon API
 * AC#3: Identity verification before proposal edits
 * AC#4: Audit events include authenticated agent ID
 * AC#5: Key rotation supported without downtime
 */

import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createAuditEvent,
	deriveAgentId,
	deserializeToken,
	generateAgentKeyPair,
	getOrCreateIdentity,
	getShortAgentId,
	issueToken,
	listAgentIds,
	loadKeyHistory,
	loadKeyPair,
	rotateKeyPair,
	serializeToken,
	signData,
	verifyAuditEvent,
	verifyOperationAuthorization,
	verifySignature,
	verifyToken,
} from "../../src/core/identity/agent-identity.ts";

describe("proposal-51: Agent Identity Authentication Protocol", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "proposal51-test-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	// ===================== AC#1: Key Generation =====================
	describe("AC#1: Agent identity keys generated on first run", () => {
		it("generates Ed25519 key pairs", () => {
			const keyPair = generateAgentKeyPair("agent-test-001");

			assert.strictEqual(keyPair.agentId, "agent-test-001");
			assert.ok(keyPair.publicKey.includes("PUBLIC KEY"));
			assert.ok(keyPair.privateKey.includes("PRIVATE KEY"));
			assert.strictEqual(keyPair.version, 1);
			assert.notStrictEqual(keyPair.created, undefined);
		});

		it("derives agent ID from public key", () => {
			const keyPair = generateAgentKeyPair("agent-test-002");
			const derivedId = deriveAgentId(keyPair.publicKey);

			assert.match(derivedId, /^agent-[a-f0-9]{16}$/);
		});

		it("returns short agent ID for display", () => {
			const shortId = getShortAgentId("agent-aabbccddee112233");

			assert.strictEqual(shortId, "aabbccdd");
		});

		it("creates identity on first run", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "test-agent");

			assert.notStrictEqual(keyPair, undefined);
			assert.strictEqual(keyPair.version, 1);
		});

		it("loads existing identity on subsequent runs", async () => {
			const first = await getOrCreateIdentity(testDir, "test-agent");
			const second = await getOrCreateIdentity(testDir, "test-agent");

			assert.strictEqual(second.agentId, first.agentId);
			assert.strictEqual(second.publicKey, first.publicKey);
			assert.strictEqual(second.created, first.created);
		});

		it("persists keys to disk", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "persist-agent");

			const loaded = await loadKeyPair(testDir, keyPair.agentId);
			assert.notStrictEqual(loaded, undefined);
			assert.strictEqual(loaded?.privateKey, keyPair.privateKey);
		});

		it("returns null for non-existent agent", async () => {
			const result = await loadKeyPair(testDir, "agent-nonexistent");
			assert.strictEqual(result, null);
		});

		it("lists all registered agent IDs", async () => {
			await getOrCreateIdentity(testDir, "agent-alpha");
			await getOrCreateIdentity(testDir, "agent-beta");

			const ids = await listAgentIds(testDir);
			assert.strictEqual(ids.length, 2);
		});
	});

	// ===================== AC#2: Token Issuance =====================
	describe("AC#2: Token issuance via daemon API", () => {
		it("issues valid authentication tokens", () => {
			const keyPair = generateAgentKeyPair("agent-token-test");
			const token = issueToken(keyPair);

			assert.match(token.token, /^tkt_[a-f0-9]{64}$/);
			assert.strictEqual(token.agentId, keyPair.agentId);
			assert.strictEqual(token.publicKey, keyPair.publicKey);
			assert.strictEqual(token.keyVersion, 1);
			assert.ok(token.expires > token.issued);
		});

		it("tokens have 24-hour expiration", () => {
			const keyPair = generateAgentKeyPair("agent-expiry-test");
			const token = issueToken(keyPair);

			const expiryMs = token.expires - token.issued;
			const hours24Ms = 24 * 60 * 60 * 1000;

			assert.strictEqual(expiryMs, hours24Ms);
		});

		it("serializes and deserializes tokens", () => {
			const keyPair = generateAgentKeyPair("agent-serialize-test");
			const token = issueToken(keyPair);

			const serialized = serializeToken(token);
			assert.strictEqual(typeof serialized, "string");
			assert.ok(!serialized.includes(token.agentId)); // Not plaintext

			const deserialized = deserializeToken(serialized);
			assert.notStrictEqual(deserialized, undefined);
			assert.strictEqual(deserialized?.agentId, token.agentId);
			assert.strictEqual(deserialized?.token, token.token);
		});

		it("returns null for invalid serialized token", () => {
			const result = deserializeToken("not-valid-base64!");
			assert.strictEqual(result, null);
		});

		it("different key pairs produce different tokens", () => {
			const keyPair1 = generateAgentKeyPair("agent-diff-1");
			const keyPair2 = generateAgentKeyPair("agent-diff-2");

			const token1 = issueToken(keyPair1);
			const token2 = issueToken(keyPair2);

			assert.notStrictEqual(token1.token, token2.token);
			assert.notStrictEqual(token1.agentId, token2.agentId);
		});
	});

	// ===================== AC#3: Identity Verification =====================
	describe("AC#3: Identity verification before proposal edits", () => {
		it("verifies valid tokens", () => {
			const keyPair = generateAgentKeyPair("agent-verify-test");
			const token = issueToken(keyPair);

			const result = verifyToken(token);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.agentId, keyPair.agentId);
			assert.strictEqual(result.reason, "Token valid");
			assert.strictEqual(result.expired, false);
		});

		it("rejects expired tokens", () => {
			const keyPair = generateAgentKeyPair("agent-expired-test");
			const token = issueToken(keyPair);

			// Simulate expired token
			token.expires = Date.now() - 1000;

			const result = verifyToken(token);

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.reason, "Token expired");
			assert.strictEqual(result.expired, true);
		});

		it("rejects tampered tokens", () => {
			const keyPair = generateAgentKeyPair("agent-tamper-test");
			const token = issueToken(keyPair);

			// Tamper with agent ID
			token.agentId = "agent-impostor";

			const result = verifyToken(token);

			assert.strictEqual(result.valid, false);
			assert.ok(result.reason.includes("mismatch"));
		});

		it("rejects tokens with invalid signatures", () => {
			const keyPair = generateAgentKeyPair("agent-sig-test");
			const token = issueToken(keyPair);

			// Tamper with signature
			token.signature = "a".repeat(128);

			const result = verifyToken(token);

			assert.strictEqual(result.valid, false);
			assert.strictEqual(result.reason, "Invalid signature");
		});

		it("verifies operation authorization with specific agent", () => {
			const keyPair = generateAgentKeyPair("agent-auth-test");
			const token = issueToken(keyPair);

			// Should pass when agent matches
			const pass = verifyOperationAuthorization(token, keyPair.agentId);
			assert.strictEqual(pass.valid, true);

			// Should fail when agent doesn't match
			const fail = verifyOperationAuthorization(token, "agent-other");
			assert.strictEqual(fail.valid, false);
			assert.ok(fail.reason.includes("not authorized"));
		});

		it("verifies operation authorization without agent constraint", () => {
			const keyPair = generateAgentKeyPair("agent-any-test");
			const token = issueToken(keyPair);

			const result = verifyOperationAuthorization(token);
			assert.strictEqual(result.valid, true);
		});
	});

	// ===================== AC#4: Audit Events =====================
	describe("AC#4: Audit events include authenticated agent ID", () => {
		it("creates signed audit events", () => {
			const keyPair = generateAgentKeyPair("agent-audit-test");
			const event = createAuditEvent(keyPair, "proposal_edit", "proposal-042", {
				field: "status",
				old: "Active",
				new: "Complete",
			});

			assert.match(event.eventId, /^audit-/);
			assert.strictEqual(event.agentId, keyPair.agentId);
			assert.strictEqual(event.action, "proposal_edit");
			assert.strictEqual(event.target, "proposal-042");
			assert.notStrictEqual(event.signature, undefined);
			assert.notStrictEqual(event.timestamp, undefined);
		});

		it("verifies audit event authenticity", () => {
			const keyPair = generateAgentKeyPair("agent-verify-audit");
			const event = createAuditEvent(
				keyPair,
				"proposal_claim",
				"proposal-051",
				{},
			);

			const isValid = verifyAuditEvent(event, keyPair.publicKey);
			assert.strictEqual(isValid, true);
		});

		it("rejects tampered audit events", () => {
			const keyPair = generateAgentKeyPair("agent-tamper-audit");
			const event = createAuditEvent(
				keyPair,
				"proposal_edit",
				"proposal-042",
				{},
			);

			// Tamper with the action
			event.action = "proposal_delete";

			const isValid = verifyAuditEvent(event, keyPair.publicKey);
			assert.strictEqual(isValid, false);
		});

		it("rejects audit events with wrong public key", () => {
			const keyPair1 = generateAgentKeyPair("agent-audit-1");
			const keyPair2 = generateAgentKeyPair("agent-audit-2");
			const event = createAuditEvent(
				keyPair1,
				"proposal_edit",
				"proposal-042",
				{},
			);

			const isValid = verifyAuditEvent(event, keyPair2.publicKey);
			assert.strictEqual(isValid, false);
		});

		it("includes all required fields in audit events", () => {
			const keyPair = generateAgentKeyPair("agent-fields-test");
			const event = createAuditEvent(
				keyPair,
				"claim_proposal",
				"proposal-055",
				{
					workload: 50,
					role: "developer",
				},
			);

			assert.notStrictEqual(event.eventId, undefined);
			assert.notStrictEqual(event.timestamp, undefined);
			assert.notStrictEqual(event.agentId, undefined);
			assert.strictEqual(event.action, "claim_proposal");
			assert.strictEqual(event.target, "proposal-055");
			assert.deepStrictEqual(event.details, {
				workload: 50,
				role: "developer",
			});
			assert.notStrictEqual(event.signature, undefined);
		});
	});

	// ===================== AC#5: Key Rotation =====================
	describe("AC#5: Key rotation supported without downtime", () => {
		it("rotates keys while preserving agent ID", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "rotate-agent");
			const originalId = keyPair.agentId;
			const originalPublicKey = keyPair.publicKey;

			const { newKeyPair, previousPublicKey } = await rotateKeyPair(
				testDir,
				keyPair,
			);

			assert.strictEqual(newKeyPair.agentId, originalId); // Same identity
			assert.strictEqual(newKeyPair.version, 2); // Version incremented
			assert.notStrictEqual(newKeyPair.publicKey, originalPublicKey); // New key
			assert.strictEqual(previousPublicKey, originalPublicKey); // Can still reference old
		});

		it("persists rotated key to disk", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "persist-rotate");
			await rotateKeyPair(testDir, keyPair);

			const loaded = await loadKeyPair(testDir, keyPair.agentId);
			assert.notStrictEqual(loaded, undefined);
			assert.strictEqual(loaded?.version, 2);
		});

		it("archives previous key versions", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "archive-test");
			await rotateKeyPair(testDir, keyPair);

			const history = await loadKeyHistory(testDir, keyPair.agentId);
			assert.ok(history.length >= 1);
			assert.strictEqual(history[0].version, 1);
		});

		it("supports multiple rotations", async () => {
			let keyPair = await getOrCreateIdentity(testDir, "multi-rotate");

			keyPair = (await rotateKeyPair(testDir, keyPair)).newKeyPair;
			keyPair = (await rotateKeyPair(testDir, keyPair)).newKeyPair;

			assert.strictEqual(keyPair.version, 3);
		});

		it("new key can issue valid tokens", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "token-after-rotate");
			const { newKeyPair } = await rotateKeyPair(testDir, keyPair);

			const token = issueToken(newKeyPair);
			const result = verifyToken(token);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.agentId, newKeyPair.agentId);
		});

		it("old key version preserved for transition period", async () => {
			const keyPair = await getOrCreateIdentity(testDir, "transition-test");
			const { newKeyPair } = await rotateKeyPair(testDir, keyPair);

			// Old key should still work for signature verification during transition
			const data = "important-proposal-data";
			const oldSig = signData(keyPair.privateKey, data);
			const newSig = signData(newKeyPair.privateKey, data);

			// Both signatures verifiable with respective keys
			assert.strictEqual(
				verifySignature(keyPair.publicKey, data, oldSig),
				true,
			);
			assert.strictEqual(
				verifySignature(newKeyPair.publicKey, data, newSig),
				true,
			);
		});
	});

	// ===================== Cross-Cutting Concerns =====================
	describe("Cross-cutting: Signature operations", () => {
		it("signs and verifies arbitrary data", () => {
			const keyPair = generateAgentKeyPair("agent-sign-test");
			const data = JSON.stringify({ action: "claim", proposal: "042" });

			const signature = signData(keyPair.privateKey, data);
			assert.notStrictEqual(signature, undefined);

			const isValid = verifySignature(keyPair.publicKey, data, signature);
			assert.strictEqual(isValid, true);
		});

		it("rejects invalid signatures", () => {
			const keyPair = generateAgentKeyPair("agent-reject-test");
			const data = "original data";
			const signature = signData(keyPair.privateKey, data);

			const isValid = verifySignature(
				keyPair.publicKey,
				"tampered data",
				signature,
			);
			assert.strictEqual(isValid, false);
		});

		it("handles special characters in signed data", () => {
			const keyPair = generateAgentKeyPair("agent-unicode-test");
			const data = "状态修改 🎯 中文测试";

			const signature = signData(keyPair.privateKey, data);
			const isValid = verifySignature(keyPair.publicKey, data, signature);
			assert.strictEqual(isValid, true);
		});
	});
});
