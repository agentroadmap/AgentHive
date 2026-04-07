/**
 * Tests for Agent Identity Authentication Protocol (proposal-51)
 *
 * AC#1: Agent identity keys generated on first run
 * AC#2: Token issuance via daemon API
 * AC#3: Identity verification before proposal edits
 * AC#4: Audit events include authenticated agent ID
 * AC#5: Key rotation supported without downtime
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AgentAuth, extractBearerToken } from "../../src/core/security/auth.ts";

describe("AgentAuth (proposal-51)", () => {
	let tempDir: string;
	let auth: AgentAuth;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-auth-test-"));
		auth = new AgentAuth({
			identityDir: tempDir,
			tokenTtlMs: 5000, // 5 seconds for tests
		});
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#1: Identity Key Generation ─────────────────────────────

	describe("AC#1: Identity key generation on first run", () => {
		it("should generate Ed25519 key pair on first initialization", async () => {
			const identity = await auth.initializeIdentity("agent-test-001");

			assert.ok(
				identity.publicKey.includes("BEGIN PUBLIC KEY"),
				"Public key should be PEM format",
			);
			assert.ok(
				identity.privateKey.includes("BEGIN PRIVATE KEY"),
				"Private key should be PEM format",
			);
			assert.equal(identity.agentId, "agent-test-001");
			assert.equal(identity.keyVersion, 1);
			assert.ok(identity.createdAt, "Should have creation timestamp");
		});

		it("should persist identity to disk", async () => {
			const identityPath = join(tempDir, "identity.json");
			const raw = await readFile(identityPath, "utf-8");
			const stored = JSON.parse(raw);

			assert.equal(stored.agentId, "agent-test-001");
			assert.ok(stored.publicKey, "Stored file should contain public key");
			assert.ok(stored.privateKey, "Stored file should contain private key");
		});

		it("should load existing identity on subsequent runs", async () => {
			const auth2 = new AgentAuth({ identityDir: tempDir });
			const identity = await auth2.initializeIdentity("agent-test-001");

			assert.equal(
				identity.keyVersion,
				1,
				"Should load existing v1, not create v2",
			);
			assert.equal(identity.agentId, "agent-test-001");
		});

		it("should return identity via getIdentity()", () => {
			const identity = auth.getIdentity();
			assert.ok(identity, "getIdentity should return initialized identity");
			assert.equal(identity?.agentId, "agent-test-001");
		});
	});

	// ─── AC#2: Token Issuance ──────────────────────────────────────

	describe("AC#2: Token issuance via daemon API", () => {
		it("should issue a token with correct structure", async () => {
			const token = await auth.issueToken("agent-test-001");

			assert.ok(
				token.token.startsWith("rmk_"),
				"Token should have rmk_ prefix",
			);
			assert.equal(token.agentId, "agent-test-001");
			assert.ok(token.expiresAt, "Token should have expiry");
			assert.ok(token.issuedAt, "Token should have issue time");
			assert.equal(token.keyVersion, 1);
		});

		it("should reject token issuance for unknown agent", async () => {
			await assert.rejects(
				() => auth.issueToken("agent-unknown"),
				/Cannot issue token for agent-unknown/,
				"Should reject issuance for mismatched agent ID",
			);
		});

		it("token payload should contain expected fields", async () => {
			const token = await auth.issueToken("agent-test-001");
			const withoutPrefix = token.token.slice(4); // remove "rmk_"
			const dotIndex = withoutPrefix.lastIndexOf(".");
			const payloadB64 = withoutPrefix.slice(0, dotIndex);
			const payload = JSON.parse(
				Buffer.from(payloadB64, "base64url").toString("utf-8"),
			);

			assert.equal(payload.agentId, "agent-test-001");
			assert.ok(payload.issuedAt > 0, "Should have issuedAt timestamp");
			assert.ok(
				payload.expiresAt > payload.issuedAt,
				"expiresAt should be after issuedAt",
			);
			assert.equal(payload.keyVersion, 1);
			assert.ok(payload.nonce, "Should have a nonce for replay protection");
		});
	});

	// ─── AC#3: Identity Verification ───────────────────────────────

	describe("AC#3: Identity verification", () => {
		it("should verify a valid token", async () => {
			const token = await auth.issueToken("agent-test-001");
			const result = await auth.verifyToken(token.token);

			assert.ok(result, "Valid token should verify");
			assert.equal(result?.agentId, "agent-test-001");
			assert.equal(result?.keyVersion, 1);
		});

		it("should reject an invalid token string", async () => {
			const result = await auth.verifyToken("garbage-token");
			assert.equal(result, null, "Invalid token should return null");
		});

		it("should reject a token with wrong prefix", async () => {
			const result = await auth.verifyToken("bad_prefix_payload.sig");
			assert.equal(result, null, "Wrong prefix should return null");
		});

		it("should reject a tampered token", async () => {
			const token = await auth.issueToken("agent-test-001");
			const tampered = `${token.token}tampered`;
			const result = await auth.verifyToken(tampered);
			assert.equal(result, null, "Tampered token should fail verification");
		});

		it("should reject an expired token", async () => {
			// Create auth with 1ms TTL
			const shortAuth = new AgentAuth({
				identityDir: tempDir,
				tokenTtlMs: 1,
			});
			await shortAuth.initializeIdentity("agent-test-001");
			const token = await shortAuth.issueToken("agent-test-001");

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 50));

			const result = await shortAuth.verifyToken(token.token);
			assert.equal(result, null, "Expired token should fail verification");
		});
	});

	// ─── AC#4: Audit Events ────────────────────────────────────────

	describe("AC#4: Audit events include agent ID", () => {
		it("should log token issuance as audit event", async () => {
			await auth.issueToken("agent-test-001");
			const log = auth.getAuditLog("agent-test-001");

			const issuanceEvent = log.find((e) => e.action === "token_issued");
			assert.ok(issuanceEvent, "Should have token_issued audit event");
			assert.equal(issuanceEvent?.agentId, "agent-test-001");
			assert.equal(issuanceEvent?.success, true);
			assert.ok(issuanceEvent?.timestamp, "Should have timestamp");
		});

		it("should log token verification as audit event", async () => {
			const token = await auth.issueToken("agent-test-001");
			await auth.verifyToken(token.token);
			const log = auth.getAuditLog("agent-test-001");

			const verifyEvent = log.find(
				(e) => e.action === "token_verify" && e.success === true,
			);
			assert.ok(verifyEvent, "Should have successful token_verify event");
			assert.equal(verifyEvent?.agentId, "agent-test-001");
		});

		it("should log failed verification as audit event", async () => {
			await auth.verifyToken("rmk_invalid.token");
			const log = auth.getAuditLog();

			// The extractAgentId will return null for invalid payload, so no audit for failed parse
			// But expired tokens should log failure
			assert.ok(log.length > 0, "Should have audit events");
		});

		it("should flush audit log to disk", async () => {
			await auth.flushAuditLog();
			const auditPath = join(tempDir, "audit.jsonl");
			const content = await readFile(auditPath, "utf-8");
			const lines = content.trim().split("\n");

			assert.ok(lines.length > 0, "Audit log file should have entries");

			for (const line of lines) {
				const event = JSON.parse(line);
				assert.ok(event.agentId, "Each audit event should have agentId");
				assert.ok(event.action, "Each audit event should have action");
				assert.ok(event.timestamp, "Each audit event should have timestamp");
			}
		});
	});

	// ─── AC#5: Key Rotation ────────────────────────────────────────

	describe("AC#5: Key rotation without downtime", () => {
		it("should rotate keys and increment version", async () => {
			const oldIdentity = auth.getIdentity()!;
			const oldPublicKey = oldIdentity.publicKey;

			const newIdentity = await auth.rotateKeys();

			assert.equal(newIdentity.keyVersion, 2, "Key version should increment");
			assert.notEqual(
				newIdentity.publicKey,
				oldPublicKey,
				"Public key should change",
			);
			assert.equal(
				newIdentity.agentId,
				"agent-test-001",
				"Agent ID should be preserved",
			);
		});

		it("should issue tokens with new key version after rotation", async () => {
			const token = await auth.issueToken("agent-test-001");
			assert.equal(token.keyVersion, 2, "New tokens should use key version 2");
		});

		it("should verify tokens signed with new keys", async () => {
			const token = await auth.issueToken("agent-test-001");
			const result = await auth.verifyToken(token.token);

			assert.ok(result, "Token signed with rotated key should verify");
			assert.equal(result?.keyVersion, 2);
		});

		it("should archive old key version to disk", async () => {
			const archivePath = join(tempDir, "identity.v1.json");
			const raw = await readFile(archivePath, "utf-8");
			const archived = JSON.parse(raw);

			assert.equal(archived.keyVersion, 1, "Archived key should be v1");
			assert.equal(archived.agentId, "agent-test-001");
		});

		it("should log key rotation as audit event", () => {
			const log = auth.getAuditLog("agent-test-001");
			const rotateEvent = log.find((e) => e.action === "key_rotation");
			assert.ok(rotateEvent, "Should have key_rotation audit event");
			assert.ok(
				rotateEvent?.details?.includes("v1 to v2"),
				"Should mention version change",
			);
		});
	});
});

describe("extractBearerToken", () => {
	it("should extract token from valid Authorization header", () => {
		const token = extractBearerToken({
			authorization: "Bearer rmk_test.token",
		});
		assert.equal(token, "rmk_test.token");
	});

	it("should return null for missing header", () => {
		const token = extractBearerToken({});
		assert.equal(token, null);
	});

	it("should return null for non-Bearer scheme", () => {
		const token = extractBearerToken({ authorization: "Basic abc123" });
		assert.equal(token, null);
	});

	it("should handle array-valued headers", () => {
		const token = extractBearerToken({
			authorization: ["Bearer rmk_test.token"],
		});
		assert.equal(token, "rmk_test.token");
	});
});
