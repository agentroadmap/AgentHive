import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
	issueBoundBearer,
	verifyBoundBearer,
	type BoundBearerToken,
	CLOCK_SKEW_MS,
} from "../src/core/identity/principal-identity.ts";
import {
	agentContextStorage,
	type VerifiedPrincipal,
} from "../src/shared/identity/agent-context.ts";
import { PoolAccessDenied } from "../src/infra/postgres/pool.ts";
import { BudgetExceededError } from "../src/shared/dispatch/budget-check.ts";
import { getProjectDb } from "../src/postgres/pool-registry.ts";

const SECRET = Buffer.from("test-hmac-secret-32bytes-padded!", "utf-8");
const WRONG_SECRET = Buffer.from("different-secret-32b-padded!!!!!", "utf-8");

describe("P841 MERGE — Auth & Resource Access Integration", () => {
	// ── P843: bearer token verification ──────────────────────────────────────

	describe("P843: verifyBoundBearer", () => {
		it("round-trip: issued token verifies with correct secret", () => {
			const token = issueBoundBearer("op:test-operator", SECRET);
			const result = verifyBoundBearer(token, SECRET);
			assert.equal(result.ok, true);
			assert.equal(result.principal_id, "op:test-operator");
		});

		it("AC#103: wrong HMAC secret → invalid_signature", () => {
			const token = issueBoundBearer("op:test-operator", SECRET);
			const result = verifyBoundBearer(token, WRONG_SECRET);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "invalid_signature");
		});

		it("AC#105: expired token → token_expired (beyond CLOCK_SKEW_MS)", () => {
			// ttlMs = -(CLOCK_SKEW_MS + 1000) → expires_at is already past tolerance
			const token = issueBoundBearer("op:test-operator", SECRET, -(CLOCK_SKEW_MS + 1000));
			const result = verifyBoundBearer(token, SECRET);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "token_expired");
		});

		it("AC#103: token with no principal_id binding → missing_principal_id_binding", () => {
			// Manually forge a valid HMAC but omit principal_id from payload
			const payload = {
				prefix: "rmk_p472",
				issued_at: Date.now(),
				expires_at: Date.now() + 60_000,
				nonce: "deadbeef",
				// deliberately no principal_id
			};
			const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
			const sig = createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
			const token = `${payloadB64}.${sig}` as BoundBearerToken;
			const result = verifyBoundBearer(token, SECRET);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "missing_principal_id_binding");
		});

		it("malformed token (no dot separator) → malformed_token", () => {
			const result = verifyBoundBearer("notavalidtoken" as BoundBearerToken, SECRET);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "malformed_token");
		});
	});

	// ── P843: agentContextStorage propagation ────────────────────────────────

	describe("P843: agentContextStorage", () => {
		it("getStore() returns undefined outside a run() call", () => {
			const ctx = agentContextStorage.getStore();
			assert.equal(ctx, undefined);
		});

		it("getStore() inside run() returns the principal that was set", async () => {
			const principal: VerifiedPrincipal = {
				principal_id: "op:ctx-test-001",
				principal_kind: "operator",
				parent_principal_id: null,
			};
			await agentContextStorage.run({ verified: principal }, async () => {
				const ctx = agentContextStorage.getStore();
				assert.ok(ctx, "context must be available inside run()");
				assert.equal(ctx.verified.principal_id, "op:ctx-test-001");
				assert.equal(ctx.verified.principal_kind, "operator");
			});
			// Verify context is gone after run() resolves
			assert.equal(agentContextStorage.getStore(), undefined);
		});

		it("P841 regression: concurrent run() calls maintain isolated contexts", async () => {
			const results: string[] = [];
			await Promise.all([
				agentContextStorage.run(
					{ verified: { principal_id: "agent:concurrent-A", principal_kind: "agent", parent_principal_id: null } },
					async () => {
						await new Promise<void>((res) => setTimeout(res, 10));
						results.push(agentContextStorage.getStore()!.verified.principal_id);
					},
				),
				agentContextStorage.run(
					{ verified: { principal_id: "agent:concurrent-B", principal_kind: "agency", parent_principal_id: null } },
					async () => {
						await new Promise<void>((res) => setTimeout(res, 5));
						results.push(agentContextStorage.getStore()!.verified.principal_id);
					},
				),
			]);
			assert.equal(results.length, 2, "Both async contexts must resolve");
			assert.ok(results.includes("agent:concurrent-A"), "agent:A context was corrupted");
			assert.ok(results.includes("agent:concurrent-B"), "agent:B context was corrupted");
		});
	});

	// ── P844: pool access gate ────────────────────────────────────────────────

	describe("P844: getProjectDb access gate", () => {
		it("AC-2: agent with no project role → PoolAccessDenied", async () => {
			const principal: VerifiedPrincipal = {
				principal_id: "agent:unregistered-001",
				principal_kind: "agent",
				parent_principal_id: "agency:parent",
			};
			await agentContextStorage.run({ verified: principal }, async () => {
				await assert.rejects(
					() => getProjectDb("test-project"),
					(err: unknown) => {
						assert.ok(
							err instanceof PoolAccessDenied,
							`Expected PoolAccessDenied, got ${(err as Error).name}: ${(err as Error).message}`,
						);
						assert.ok(
							(err as Error).message.includes("agent:unregistered-001"),
							"Error must reference the denied principal_id",
						);
						assert.ok(
							(err as Error).message.includes("test-project"),
							"Error must reference the target project slug",
						);
						return true;
					},
				);
			});
		});

		it("AC-2b: P844 gate predicate does not fire for operator principal_kind", async () => {
			// The P844 gate checks `principal_kind === "agent"` — operators bypass it entirely.
			// Verify the predicate is false for operator context (no DB needed).
			await agentContextStorage.run(
				{ verified: { principal_id: "op:operator-001", principal_kind: "operator", parent_principal_id: null } },
				() => {
					const ctx = agentContextStorage.getStore();
					assert.ok(ctx?.verified, "operator context must be present");
					assert.notEqual(
						ctx?.verified.principal_kind,
						"agent",
						"Operator kind must not match P844 agent gate predicate",
					);
				},
			);
		});
	});

	// ── P842: BudgetExceededError class contract ──────────────────────────────

	describe("P842-AC-1: BudgetExceededError class contract", () => {
		it("project_cap: name, message prefix, and cap_type are correct", () => {
			const err = new BudgetExceededError("project_cap");
			assert.equal(err.name, "BudgetExceededError");
			assert.ok(err.message.includes("[P842]"), "message must include [P842] tag");
			assert.equal(err.cap_type, "project_cap");
			assert.ok(err instanceof Error, "must extend Error");
		});

		it("agent_cap: name, message prefix, and cap_type are correct", () => {
			const err = new BudgetExceededError("agent_cap");
			assert.equal(err.name, "BudgetExceededError");
			assert.ok(err.message.includes("[P842]"), "message must include [P842] tag");
			assert.equal(err.cap_type, "agent_cap");
		});

		it("redaction: message must not expose principal_id, balance, or period", () => {
			const err = new BudgetExceededError("agent_cap");
			assert.ok(!err.message.includes("principal_id"), "message must not expose principal_id");
			assert.ok(!err.message.includes("max_usd_cents"), "message must not expose balance field");
			assert.ok(!err.message.includes("period"), "message must not expose period details");
		});
	});
});
