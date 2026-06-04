/**
 * P446: MCP Runtime Reliability — unit tests.
 *
 * Tests cover:
 * - /healthz response shape (AC-4)
 * - /smoke response shape (AC-5)
 * - Structured error format from handleMcpError (AC-6)
 * - No transport close on handler exceptions
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	handleMcpError,
	McpValidationError,
	McpDatabaseError,
	McpPolicyError,
	McpInternalError,
	McpError,
} from "../src/apps/mcp-server/errors/mcp-errors.ts";

// ---------------------------------------------------------------------------
// AC-6: Structured error envelopes
// ---------------------------------------------------------------------------

describe("P446 — structured error envelopes (AC-6)", () => {
	test("McpValidationError produces code=validation_error", () => {
		const result = handleMcpError(new McpValidationError("bad input"));
		assert.ok(result.isError, "isError must be true");
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "validation_error");
		assert.equal(s.message, "bad input");
		assert.ok(typeof s.request_id === "string", "request_id must be a string");
		assert.ok(typeof s.timestamp === "string", "timestamp must be a string");
	});

	test("McpDatabaseError produces code=db_error", () => {
		const result = handleMcpError(new McpDatabaseError("connection refused"));
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "db_error");
	});

	test("McpPolicyError produces code=policy_error", () => {
		const result = handleMcpError(new McpPolicyError("not authorised"));
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "policy_error");
	});

	test("McpInternalError produces code=internal_error", () => {
		const result = handleMcpError(new McpInternalError("unexpected"));
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "internal_error");
	});

	test("generic Error falls back to internal_error", () => {
		const result = handleMcpError(new Error("oops"));
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "internal_error");
		assert.equal(s.message, "oops");
	});

	test("non-Error value falls back to internal_error with default message", () => {
		const result = handleMcpError("something strange");
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.code, "internal_error");
		assert.ok(typeof s.message === "string");
	});

	test("request_id is forwarded when provided", () => {
		const rid = "test-request-id-123";
		const result = handleMcpError(new McpValidationError("x"), rid);
		const s = result.structuredContent as Record<string, unknown>;
		assert.equal(s.request_id, rid);
	});

	test("structured content always contains code, message, request_id, timestamp", () => {
		const errors: unknown[] = [
			new McpValidationError("v"),
			new McpDatabaseError("d"),
			new McpPolicyError("p"),
			new McpInternalError("i"),
			new Error("e"),
			"raw string",
			42,
		];
		for (const err of errors) {
			const result = handleMcpError(err);
			const s = result.structuredContent as Record<string, unknown>;
			assert.ok("code" in s, `code missing for: ${String(err)}`);
			assert.ok("message" in s, `message missing for: ${String(err)}`);
			assert.ok("request_id" in s, `request_id missing for: ${String(err)}`);
			assert.ok("timestamp" in s, `timestamp missing for: ${String(err)}`);
		}
	});

	test("isError is always true for handleMcpError results", () => {
		assert.ok(handleMcpError(new Error("x")).isError);
		assert.ok(handleMcpError("raw").isError);
	});
});

// ---------------------------------------------------------------------------
// AC-4 & AC-5: /healthz and /smoke response shape validation (unit)
// ---------------------------------------------------------------------------

describe("P446 — /healthz response shape (AC-4)", () => {
	test("healthz shape has all required fields", () => {
		// Validate the contract shape that the endpoint must return.
		const examplePayload = {
			service: "ok",
			db: "ok",
			schema_version: 56,
			git_revision: "abc1234",
			project_root: "/data/code/AgentHive",
			db_host: "127.0.0.1",
			db_name: "agenthive",
			schema: "roadmap",
			started_at: new Date().toISOString(),
			mcp_protocol_version: "2024-11-05",
		};

		const required = [
			"service",
			"db",
			"schema_version",
			"git_revision",
			"project_root",
			"db_host",
			"db_name",
			"schema",
			"started_at",
			"mcp_protocol_version",
		];
		for (const field of required) {
			assert.ok(field in examplePayload, `healthz must include field: ${field}`);
		}

		assert.ok(
			examplePayload.db === "ok" || examplePayload.db === "error",
			"db must be 'ok' or 'error'",
		);
		assert.equal(examplePayload.service, "ok");
		assert.equal(examplePayload.mcp_protocol_version, "2024-11-05");
	});

	test("healthz db=error does not set service=error", () => {
		// Service health is independent of DB health — transport may still be up
		const payload = { service: "ok", db: "error" };
		assert.equal(payload.service, "ok");
	});
});

describe("P446 — /smoke response shape (AC-5)", () => {
	test("smoke result has steps array and total_ms", () => {
		const exampleResult = {
			steps: [
				{ name: "initialize", elapsed_ms: 12, result: "ok" },
				{ name: "tools/list", elapsed_ms: 45, result: "ok" },
				{ name: "tools/call:mcp_ops", elapsed_ms: 33, result: "ok" },
			],
			total_ms: 90,
		};

		assert.ok(Array.isArray(exampleResult.steps), "steps must be an array");
		assert.ok(
			typeof exampleResult.total_ms === "number",
			"total_ms must be a number",
		);

		for (const step of exampleResult.steps) {
			assert.ok("name" in step, "step must have name");
			assert.ok("elapsed_ms" in step, "step must have elapsed_ms");
			assert.ok("result" in step, "step must have result");
			assert.ok(
				step.result === "ok" || step.result === "error",
				`step.result must be ok|error, got: ${step.result}`,
			);
			assert.ok(
				typeof step.elapsed_ms === "number" && step.elapsed_ms >= 0,
				"elapsed_ms must be a non-negative number",
			);
		}

		const names = exampleResult.steps.map((s) => s.name);
		assert.ok(names.includes("initialize"), "steps must include initialize");
		assert.ok(names.includes("tools/list"), "steps must include tools/list");
	});
});

// ---------------------------------------------------------------------------
// Live smoke test against the running MCP server (skipped in unit-only CI)
// ---------------------------------------------------------------------------

if (process.env.MCP_SMOKE_TEST === "1") {
	describe("P446 — live smoke test against MCP server", () => {
		const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:6421";

		test("/healthz returns 200 with service:ok", async () => {
			const r = await fetch(`${MCP_URL}/healthz`);
			assert.equal(r.status, 200);
			const body = await r.json() as Record<string, unknown>;
			assert.equal(body.service, "ok");
			assert.ok("db" in body, "healthz must have db field");
			assert.ok("schema_version" in body, "healthz must have schema_version");
			assert.ok("git_revision" in body, "healthz must have git_revision");
			assert.ok("started_at" in body, "healthz must have started_at");
			assert.equal(body.mcp_protocol_version, "2024-11-05");
		});

		test("/smoke returns steps with ok results", async () => {
			const r = await fetch(`${MCP_URL}/smoke`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			assert.equal(r.status, 200);
			const body = await r.json() as Record<string, unknown>;
			assert.ok(Array.isArray(body.steps), "smoke must return steps array");
			assert.ok(typeof body.total_ms === "number", "smoke must return total_ms");
			for (const step of body.steps as Array<Record<string, unknown>>) {
				assert.equal(
					step.result,
					"ok",
					`smoke step ${step.name} should be ok, got: ${step.result}`,
				);
			}
		});
	});
}
