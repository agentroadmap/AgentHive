/**
 * P446 AC-6: Structured error envelopes — unit tests.
 *
 * Verifies that handleMcpError always returns a CallToolResult with
 * the required envelope shape {code, message, request_id, timestamp}
 * and never throws (transport-safe).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	handleMcpError,
	McpValidationError,
	McpDatabaseError,
	McpPolicyError,
	McpInternalError,
	McpConnectionError,
} from "./mcp-errors.ts";

describe("P446 AC-6 — handleMcpError structured envelope", () => {
	test("returns validation_error code for McpValidationError", () => {
		const err = new McpValidationError("bad input");
		const result = handleMcpError(err, "req-001");
		assert.ok(result.isError);
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "validation_error");
		assert.equal(sc.message, "bad input");
		assert.equal(sc.request_id, "req-001");
		assert.ok(typeof sc.timestamp === "string");
	});

	test("returns db_error code for McpDatabaseError", () => {
		const err = new McpDatabaseError("connection refused");
		const result = handleMcpError(err, "req-002");
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "db_error");
		assert.equal(sc.request_id, "req-002");
	});

	test("returns policy_error code for McpPolicyError", () => {
		const err = new McpPolicyError("not authorised");
		const result = handleMcpError(err, "req-003");
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "policy_error");
	});

	test("returns internal_error code for McpInternalError", () => {
		const err = new McpInternalError("unexpected");
		const result = handleMcpError(err, "req-004");
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "internal_error");
	});

	test("returns internal_error for plain Error (unknown error)", () => {
		const err = new Error("something exploded");
		const result = handleMcpError(err, "req-005");
		assert.ok(result.isError);
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "internal_error");
		assert.equal(sc.message, "something exploded");
		assert.equal(sc.request_id, "req-005");
		assert.ok(typeof sc.timestamp === "string");
	});

	test("returns internal_error for non-Error thrown value", () => {
		const result = handleMcpError("just a string", "req-006");
		assert.ok(result.isError);
		const sc = result.structuredContent as Record<string, unknown>;
		assert.equal(sc.code, "internal_error");
	});

	test("generates request_id when not supplied", () => {
		const err = new McpConnectionError("timeout");
		const result = handleMcpError(err);
		const sc = result.structuredContent as Record<string, unknown>;
		assert.ok(typeof sc.request_id === "string" && sc.request_id.length > 0);
	});

	test("never throws — safe to call from any handler", () => {
		assert.doesNotThrow(() => handleMcpError(null, "req-007"));
		assert.doesNotThrow(() => handleMcpError(undefined, "req-008"));
		assert.doesNotThrow(() => handleMcpError({ weird: true }, "req-009"));
	});

	test("content array has text item with message", () => {
		const err = new McpValidationError("field required");
		const result = handleMcpError(err, "req-010");
		assert.ok(Array.isArray(result.content) && result.content.length > 0);
		const item = result.content[0] as { type: string; text: string };
		assert.equal(item.type, "text");
	});
});
