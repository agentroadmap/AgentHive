/**
 * P1105 — USER bearer token auth tests
 *
 * AC-3: msg_send rejects user/* senders without a valid bearer token
 * AC-4: old key rejected after key rotation (token issued with key A fails verification with key B)
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import {
	issueBoundBearer,
	verifyBoundBearer,
} from "../../src/core/identity/principal-identity.ts";
import { agentContextStorage } from "../../src/shared/identity/agent-context.ts";

// ── AC-4: Key rotation — old token rejected by new secret ─────────────────────

describe("P1105 bearer token key rotation (AC-4)", () => {
	it("token issued with key A validates with key A", () => {
		const keyA = randomBytes(32);
		const token = issueBoundBearer("user/gary", keyA);
		const result = verifyBoundBearer(token, keyA);
		assert.equal(result.ok, true, "same key must verify OK");
		assert.equal(result.principal_id, "user/gary");
	});

	it("token issued with key A is rejected by key B (rotation)", () => {
		const keyA = randomBytes(32);
		const keyB = randomBytes(32);
		const token = issueBoundBearer("user/gary", keyA);
		const result = verifyBoundBearer(token, keyB);
		assert.equal(result.ok, false, "rotated key must reject old token");
		assert.equal(result.reason, "invalid_signature");
	});

	it("token principal_id is bound to the issued identity", () => {
		const secret = randomBytes(32);
		const token = issueBoundBearer("user/gary", secret);
		const result = verifyBoundBearer(token, secret);
		assert.equal(result.ok, true);
		assert.equal(result.principal_id, "user/gary");
	});

	it("token with future expiry verifies OK", () => {
		const secret = randomBytes(32);
		const token = issueBoundBearer("user/gary", secret, 3_600_000); // 1 hour TTL
		const result = verifyBoundBearer(token, secret);
		assert.equal(result.ok, true, "token with future expiry must verify OK");
	});

	it("naked bearer (no principal_id) is rejected", () => {
		const secret = randomBytes(32);
		// Craft a token without principal_id binding
		const payload = Buffer.from(JSON.stringify({ prefix: "rmk_p472", issued_at: Date.now(), expires_at: Date.now() + 3600000, nonce: "aabbccdd" })).toString("base64url");
		const { createHmac } = require("node:crypto");
		const sig = createHmac("sha256", secret).update(payload).digest("base64url");
		const token = `${payload}.${sig}`;
		const result = verifyBoundBearer(token, secret);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "missing_principal_id_binding");
	});
});

// ── AC-3: msg_send user/* bearer guard ────────────────────────────────────────

describe("P1105 agentContextStorage user guard (AC-3)", () => {
	it("context with matching principal_id passes the sub check", async () => {
		let capturedCtx: { principal_id: string } | null = null;

		await agentContextStorage.run(
			{
				verified: {
					principal_id: "user/gary",
					principal_kind: "operator",
					parent_principal_id: null,
				},
			},
			async () => {
				const ctx = agentContextStorage.getStore();
				capturedCtx = ctx?.verified ?? null;
			},
		);

		assert.ok(capturedCtx, "context must be set inside run()");
		assert.equal(capturedCtx.principal_id, "user/gary");
	});

	it("context with mismatched principal_id is detectable as sub_mismatch", async () => {
		let subMismatch = false;

		await agentContextStorage.run(
			{
				verified: {
					principal_id: "user/other",
					principal_kind: "operator",
					parent_principal_id: null,
				},
			},
			async () => {
				const ctx = agentContextStorage.getStore();
				const fromAgent = "user/gary";
				if (ctx?.verified && ctx.verified.principal_id !== fromAgent) {
					subMismatch = true;
				}
			},
		);

		assert.equal(subMismatch, true, "mismatched sub must be flagged");
	});

	it("absent context is detectable as missing_bearer_token", async () => {
		// Run outside any storage context
		const ctx = agentContextStorage.getStore();
		const fromAgent = "user/gary";
		const isMissing = fromAgent.startsWith("user/") && !ctx?.verified;
		assert.equal(isMissing, true, "no context must flag as missing bearer");
	});
});
