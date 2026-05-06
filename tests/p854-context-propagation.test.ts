import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	issueBoundBearer,
} from "../src/core/identity/principal-identity.ts";
import {
	agentContextStorage,
} from "../src/shared/identity/agent-context.ts";

/**
 * P854: Verify runWithBearerContext() and the _auth→agentContextStorage propagation fix.
 *
 * These tests exercise the contract without a live DB or full McpServer — they
 * test agentContextStorage isolation directly and the bearer-context wrapper via
 * a minimal stub that mirrors McpServer.runWithBearerContext().
 */

const SECRET = Buffer.from("test-hmac-secret-32bytes-padded!", "utf-8");
const WRONG_SECRET = Buffer.from("different-secret-32b-padded!!!!!", "utf-8");

// Minimal stand-in for McpServer.runWithBearerContext() to test the contract
// without spinning up a full server.
async function runWithBearerContext<T>(
	authHeader: string | undefined,
	secret: Buffer,
	fn: () => Promise<T>,
): Promise<T> {
	const { verifyBoundBearer } = await import("../src/core/identity/principal-identity.ts");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7) as Parameters<typeof verifyBoundBearer>[0];
		const res = verifyBoundBearer(token, secret);
		if (res.ok && res.principal_id) {
			return agentContextStorage.run(
				{ verified: { principal_id: res.principal_id, principal_kind: "operator", parent_principal_id: null } },
				fn,
			);
		}
	}
	return fn();
}

describe("P854: agentContextStorage propagation fixes", () => {
	describe("runWithBearerContext — bearer auth → context propagation", () => {
		it("valid bearer: fn runs with operator context set", async () => {
			const token = issueBoundBearer("op:p854-test", SECRET);
			let capturedId: string | undefined;

			await runWithBearerContext(`Bearer ${token}`, SECRET, async () => {
				capturedId = agentContextStorage.getStore()?.verified.principal_id;
			});

			assert.equal(capturedId, "op:p854-test");
		});

		it("valid bearer: principal_kind is operator", async () => {
			const token = issueBoundBearer("op:p854-kind-test", SECRET);
			let capturedKind: string | undefined;

			await runWithBearerContext(`Bearer ${token}`, SECRET, async () => {
				capturedKind = agentContextStorage.getStore()?.verified.principal_kind;
			});

			assert.equal(capturedKind, "operator");
		});

		it("wrong secret: fn runs WITHOUT context (token not trusted)", async () => {
			const token = issueBoundBearer("op:p854-wrong", WRONG_SECRET);
			let capturedCtx: unknown;

			await runWithBearerContext(`Bearer ${token}`, SECRET, async () => {
				capturedCtx = agentContextStorage.getStore();
			});

			assert.equal(capturedCtx, undefined);
		});

		it("no header: fn runs WITHOUT context", async () => {
			let capturedCtx: unknown;
			await runWithBearerContext(undefined, SECRET, async () => {
				capturedCtx = agentContextStorage.getStore();
			});
			assert.equal(capturedCtx, undefined);
		});

		it("malformed header (no Bearer prefix): fn runs WITHOUT context", async () => {
			let capturedCtx: unknown;
			await runWithBearerContext("Basic dXNlcjpwYXNz", SECRET, async () => {
				capturedCtx = agentContextStorage.getStore();
			});
			assert.equal(capturedCtx, undefined);
		});

		it("context is torn down after fn completes", async () => {
			const token = issueBoundBearer("op:p854-teardown", SECRET);
			await runWithBearerContext(`Bearer ${token}`, SECRET, async () => {});
			assert.equal(agentContextStorage.getStore(), undefined);
		});
	});

	describe("_auth envelope → agentContextStorage (Part A contract)", () => {
		it("context set inside agentContextStorage.run() is visible to nested async calls", async () => {
			// This mirrors what callTool() now does: agentContextStorage.run(verifiedPrincipal, handler)
			// where handler may call getProjectDb() which reads the store.
			let nestedId: string | undefined;

			await agentContextStorage.run(
				{ verified: { principal_id: "agent:p854-nested", principal_kind: "agent", parent_principal_id: "agency:root" } },
				async () => {
					// Simulate async work (e.g., getProjectDb lookup) inside the handler
					await new Promise<void>((r) => setTimeout(r, 0));
					nestedId = agentContextStorage.getStore()?.verified.principal_id;
				},
			);

			assert.equal(nestedId, "agent:p854-nested");
			assert.equal(agentContextStorage.getStore(), undefined, "context must be gone after run()");
		});

		it("two concurrent _auth handlers maintain isolated contexts", async () => {
			const results: Array<{ id: string; kind: string }> = [];

			await Promise.all([
				agentContextStorage.run(
					{ verified: { principal_id: "agent:p854-A", principal_kind: "agent", parent_principal_id: null } },
					async () => {
						await new Promise<void>((r) => setTimeout(r, 10));
						const ctx = agentContextStorage.getStore()!.verified;
						results.push({ id: ctx.principal_id, kind: ctx.principal_kind });
					},
				),
				agentContextStorage.run(
					{ verified: { principal_id: "op:p854-B", principal_kind: "operator", parent_principal_id: null } },
					async () => {
						await new Promise<void>((r) => setTimeout(r, 5));
						const ctx = agentContextStorage.getStore()!.verified;
						results.push({ id: ctx.principal_id, kind: ctx.principal_kind });
					},
				),
			]);

			assert.equal(results.length, 2);
			const a = results.find((r) => r.id === "agent:p854-A");
			const b = results.find((r) => r.id === "op:p854-B");
			assert.ok(a, "agent:p854-A context was corrupted");
			assert.equal(a?.kind, "agent");
			assert.ok(b, "op:p854-B context was corrupted");
			assert.equal(b?.kind, "operator");
		});
	});
});
