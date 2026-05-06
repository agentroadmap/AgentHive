/**
 * P834 Integration Tests — Cryptographic Identity Services
 *
 * Suite 2 of the A2A test plan (a2aTest session, 2026-05-05).
 *
 * Pure-function tests for src/infra/security/agent-crypto.ts and the in-memory
 * credential bootstrap protocol in src/apps/mcp-server/tools/messages/credential-handlers.ts.
 *
 * No DB dependency. No fixtures. Self-contained.
 *
 * NOTE: Round-trip ECDH session-key derivation is NOT covered here — the
 * production code stores the credential envelope in spawn_bucket without
 * performing the actual ECDH exchange (see credential-handlers.ts comment
 * "In production, this would..."). Tests below cover the protocol state
 * machine (claim idempotency, identity mismatch) only.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import {
	agentCredentialClaim,
	agentCredentialDeliver,
	agentCredentialRetrieve,
	spawnManifestCreate,
} from "../../src/apps/mcp-server/tools/messages/credential-handlers.ts";
import {
	decryptSecret,
	deriveSigningKey,
	encryptSecret,
	signMessage,
	verifySignature,
} from "../../src/infra/security/agent-crypto.ts";

// Use a deterministic master key for tests so that no random fallback fires.
// Restore previous value (or unset) in process.exit ordering — tests run in a
// single process so all suites share this env.
process.env.AGENT_MASTER_KEY = crypto.randomBytes(32).toString("hex");

// ─── encryptSecret / decryptSecret ─────────────────────────────────────────────

describe("agent-crypto: encryptSecret / decryptSecret", () => {
	const agentIdentity = "test/p834/agent-alpha";
	const secret = crypto.randomBytes(64);

	it("round-trip: encrypt → decrypt yields original plaintext", () => {
		const { encrypted, nonce, tag } = encryptSecret(agentIdentity, secret);
		const decrypted = decryptSecret(agentIdentity, encrypted, nonce, tag);
		assert.ok(decrypted, "decrypt returned null");
		assert.deepEqual(decrypted, secret);
	});

	it("rejects non-64-byte secret on encrypt", () => {
		assert.throws(() => encryptSecret(agentIdentity, crypto.randomBytes(32)), /64 bytes/);
	});

	it("returns null when agent_identity (AAD) does not match", () => {
		const { encrypted, nonce, tag } = encryptSecret(agentIdentity, secret);
		const decrypted = decryptSecret("test/p834/agent-beta", encrypted, nonce, tag);
		assert.equal(decrypted, null, "tampered AAD must fail authentication");
	});

	it("returns null when ciphertext is tampered", () => {
		const { encrypted, nonce, tag } = encryptSecret(agentIdentity, secret);
		const tampered = Buffer.from(encrypted);
		tampered[0] = tampered[0] ^ 0x01;
		const decrypted = decryptSecret(agentIdentity, tampered, nonce, tag);
		assert.equal(decrypted, null);
	});

	it("returns null when nonce is replaced", () => {
		const { encrypted, tag } = encryptSecret(agentIdentity, secret);
		const wrongNonce = crypto.randomBytes(12);
		const decrypted = decryptSecret(agentIdentity, encrypted, wrongNonce, tag);
		assert.equal(decrypted, null);
	});

	it("returns null when GCM tag is tampered", () => {
		const { encrypted, nonce, tag } = encryptSecret(agentIdentity, secret);
		const tamperedTag = Buffer.from(tag);
		tamperedTag[0] = tamperedTag[0] ^ 0x01;
		const decrypted = decryptSecret(agentIdentity, encrypted, nonce, tamperedTag);
		assert.equal(decrypted, null);
	});

	it("rejects malformed nonce length on decrypt", () => {
		const { encrypted, tag } = encryptSecret(agentIdentity, secret);
		assert.throws(
			() => decryptSecret(agentIdentity, encrypted, Buffer.alloc(8), tag),
			/Nonce must be 12 bytes/,
		);
	});

	it("rejects malformed tag length on decrypt", () => {
		const { encrypted, nonce } = encryptSecret(agentIdentity, secret);
		assert.throws(
			() => decryptSecret(agentIdentity, encrypted, nonce, Buffer.alloc(8)),
			/Tag must be 16 bytes/,
		);
	});
});

// ─── deriveSigningKey (HKDF) ───────────────────────────────────────────────────

describe("agent-crypto: deriveSigningKey (HKDF context binding)", () => {
	const secret = crypto.randomBytes(64);
	// Anchor at an exact minute boundary so `baseEpoch + 59` is still in the same minute window.
	const baseEpoch = Math.floor(1_700_000_000 / 60) * 60;

	it("is deterministic for identical inputs", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		assert.deepEqual(a, b);
		assert.equal(a.length, 32);
	});

	it("different sender → different key", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "carol", "bob", "task", baseEpoch);
		assert.notDeepEqual(a, b);
	});

	it("different recipient → different key", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "alice", "dan", "task", baseEpoch);
		assert.notDeepEqual(a, b);
	});

	it("different message_type → different key", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "alice", "bob", "directive", baseEpoch);
		assert.notDeepEqual(a, b);
	});

	it("different 60-second time window → different key", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch + 60);
		assert.notDeepEqual(a, b);
	});

	it("same minute window → same key (boundary check)", () => {
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		const b = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch + 59);
		assert.deepEqual(a, b);
	});

	it("explicit salt overrides deterministic salt", () => {
		const customSalt = crypto.randomBytes(32);
		const a = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch, customSalt);
		const b = deriveSigningKey(secret, "alice", "bob", "task", baseEpoch);
		assert.notDeepEqual(a, b);
	});
});

// ─── signMessage / verifySignature ─────────────────────────────────────────────

describe("agent-crypto: signMessage / verifySignature", () => {
	const secret = crypto.randomBytes(64);
	const epoch = 1_700_000_000;
	const payload = crypto.createHash("sha256").update("hello world").digest();

	it("round-trip: sign → verify passes", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		const ok = verifySignature(secret, "alice", "bob", "task", epoch, payload, sig);
		assert.equal(ok, true);
	});

	it("verify fails when payload SHA changes", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		const tamperedPayload = crypto.createHash("sha256").update("HELLO world").digest();
		const ok = verifySignature(secret, "alice", "bob", "task", epoch, tamperedPayload, sig);
		assert.equal(ok, false);
	});

	it("verify fails when sender identity changes", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		const ok = verifySignature(secret, "mallory", "bob", "task", epoch, payload, sig);
		assert.equal(ok, false);
	});

	it("verify fails when recipient identity changes", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		const ok = verifySignature(secret, "alice", "dan", "task", epoch, payload, sig);
		assert.equal(ok, false);
	});

	it("verify fails when message_type changes", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		const ok = verifySignature(secret, "alice", "bob", "directive", epoch, payload, sig);
		assert.equal(ok, false);
	});

	it("verify gracefully returns false on invalid hex (no throw)", () => {
		const ok = verifySignature(secret, "alice", "bob", "task", epoch, payload, "not-hex-zzz");
		assert.equal(ok, false);
	});

	it("verify gracefully returns false on length mismatch (no throw)", () => {
		const ok = verifySignature(secret, "alice", "bob", "task", epoch, payload, "deadbeef");
		assert.equal(ok, false);
	});

	it("uses constant-time comparison (timingSafeEqual) — equal-length tampered hex returns false without throw", () => {
		const sig = signMessage(secret, "alice", "bob", "task", epoch, payload);
		// Flip one hex digit in the middle to keep the length identical.
		const flipped = sig.slice(0, 8) + (sig[8] === "0" ? "1" : "0") + sig.slice(9);
		assert.equal(flipped.length, sig.length);
		const ok = verifySignature(secret, "alice", "bob", "task", epoch, payload, flipped);
		assert.equal(ok, false);
	});
});

// ─── credential bootstrap state machine ────────────────────────────────────────

function freshManifest() {
	const result = spawnManifestCreate({
		parent_identity: "test/p834/parent",
		child_identity: "test/p834/child",
		agency_id: "test-p834-agency",
		allowed_scopes: ["proposal:read"],
		denied_scopes: ["proposal:delete"],
		max_spawn_depth: 1,
		parent_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
		parent_sig: "deadbeef",
	});
	if ("error" in result) throw new Error(result.error);
	return result;
}

function parseToolResult(r: { content: { type: string; text: string }[] }): {
	ok: boolean;
	body: string;
	json: any | null;
} {
	const text = r.content[0]?.text ?? "";
	const ok = !text.startsWith("⚠️");
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { ok, body: text, json };
}

describe("credential-handlers: agentCredentialClaim", () => {
	it("first claim succeeds and confirms nonce + child identity", () => {
		const { nonce } = freshManifest();
		const childPub = crypto.randomBytes(32).toString("hex");
		const r = parseToolResult(
			agentCredentialClaim({
				nonce,
				child_ephemeral_public_key: childPub,
				child_identity: "test/p834/child",
			}),
		);
		assert.equal(r.ok, true, r.body);
		assert.equal(r.json?.claimed, true);
		assert.equal(r.json?.nonce_confirmed, nonce);
		assert.equal(r.json?.child_identity, "test/p834/child");
	});

	it("second claim with same nonce is rejected (single-use)", () => {
		const { nonce } = freshManifest();
		agentCredentialClaim({
			nonce,
			child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
			child_identity: "test/p834/child",
		});
		const r = parseToolResult(
			agentCredentialClaim({
				nonce,
				child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
				child_identity: "test/p834/child",
			}),
		);
		assert.equal(r.ok, false);
		assert.match(r.body, /NONCE_ALREADY_CLAIMED/);
	});

	it("rejects claim from a child whose identity does not match the manifest", () => {
		const { nonce } = freshManifest();
		const r = parseToolResult(
			agentCredentialClaim({
				nonce,
				child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
				child_identity: "test/p834/imposter",
			}),
		);
		assert.equal(r.ok, false);
		assert.match(r.body, /CHILD_IDENTITY_MISMATCH/);
	});

	it("rejects unknown nonce", () => {
		const r = parseToolResult(
			agentCredentialClaim({
				nonce: crypto.randomBytes(32).toString("hex"),
				child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
				child_identity: "test/p834/child",
			}),
		);
		assert.equal(r.ok, false);
		assert.match(r.body, /NONCE_NOT_FOUND/);
	});
});

describe("credential-handlers: agentCredentialDeliver / agentCredentialRetrieve", () => {
	function envelopeArgs(nonce: string) {
		return {
			nonce,
			child_agent_secret_encrypted: crypto.randomBytes(80).toString("hex"),
			encryption_nonce: crypto.randomBytes(12).toString("hex"),
			encryption_tag: crypto.randomBytes(16).toString("hex"),
			grant_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
		};
	}

	it("deliver fails before claim completes", () => {
		const { nonce } = freshManifest();
		const r = parseToolResult(agentCredentialDeliver(envelopeArgs(nonce)));
		assert.equal(r.ok, false);
		assert.match(r.body, /CREDENTIAL_NOT_CLAIMED/);
	});

	it("deliver succeeds after claim and round-trips through retrieve", () => {
		const { nonce } = freshManifest();
		agentCredentialClaim({
			nonce,
			child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
			child_identity: "test/p834/child",
		});

		const args = envelopeArgs(nonce);
		const deliverR = parseToolResult(agentCredentialDeliver(args));
		assert.equal(deliverR.ok, true, deliverR.body);
		assert.equal(deliverR.json?.delivered, true);
		assert.equal(deliverR.json?.nonce, nonce);

		const retrieveR = parseToolResult(agentCredentialRetrieve({ nonce }));
		assert.equal(retrieveR.ok, true, retrieveR.body);
		assert.equal(retrieveR.json?.nonce, nonce);
		assert.equal(retrieveR.json?.child_agent_secret_encrypted, args.child_agent_secret_encrypted);
		assert.equal(retrieveR.json?.encryption_nonce, args.encryption_nonce);
		assert.equal(retrieveR.json?.encryption_tag, args.encryption_tag);
		assert.equal(retrieveR.json?.grant_expires_at, args.grant_expires_at);
	});

	it("deliver on unknown nonce returns SPAWN_ENTRY_NOT_FOUND", () => {
		const r = parseToolResult(
			agentCredentialDeliver(envelopeArgs(crypto.randomBytes(32).toString("hex"))),
		);
		assert.equal(r.ok, false);
		assert.match(r.body, /SPAWN_ENTRY_NOT_FOUND/);
	});

	it("retrieve before deliver returns CREDENTIAL_NOT_DELIVERED", () => {
		const { nonce } = freshManifest();
		agentCredentialClaim({
			nonce,
			child_ephemeral_public_key: crypto.randomBytes(32).toString("hex"),
			child_identity: "test/p834/child",
		});
		const r = parseToolResult(agentCredentialRetrieve({ nonce }));
		assert.equal(r.ok, false);
		assert.match(r.body, /CREDENTIAL_NOT_DELIVERED/);
	});

	it("retrieve on unknown nonce returns SPAWN_ENTRY_NOT_FOUND", () => {
		const r = parseToolResult(
			agentCredentialRetrieve({ nonce: crypto.randomBytes(32).toString("hex") }),
		);
		assert.equal(r.ok, false);
		assert.match(r.body, /SPAWN_ENTRY_NOT_FOUND/);
	});
});
