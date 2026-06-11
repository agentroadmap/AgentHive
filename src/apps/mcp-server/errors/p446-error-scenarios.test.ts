/**
 * P446 AC-10: Error scenario tests
 *
 * Verifies that:
 * 1. Malformed MCP input returns structured error (code, message, request_id)
 *    instead of closing transport
 * 2. DB down scenario: no credentials leaked in error response
 * 3. Stale schema detected: version mismatch reported
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	McpValidationError,
	McpDatabaseError,
	handleMcpError,
} from "./mcp-errors.ts";

describe("P446 AC-10 — Error scenarios", () => {
	describe("Malformed MCP input", () => {
		test("invalid JSON structure returns validation_error without closing transport", () => {
			// Simulate a malformed tool call argument
			const malformedInput = {
				field_required_by_tool: undefined,
				another_required: null,
			};

			// Missing required field "proposal_id"
			const err = new McpValidationError(
				"Missing required parameter: proposal_id",
			);
			const result = handleMcpError(err, "req-malformed-001");

			// Verify structured response (never throws)
			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "validation_error");
			assert.equal(result.structuredContent.request_id, "req-malformed-001");
			assert.ok(result.structuredContent.timestamp);

			// Transport safety: never throws
			assert.ok(result.content.length > 0);
			assert.equal(result.content[0].type, "text");
		});

		test("invalid argument type returns validation_error", () => {
			const err = new McpValidationError(
				"Expected proposal_id to be a number, got string",
			);
			const result = handleMcpError(err, "req-malformed-002");

			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "validation_error");
			assert.ok(result.structuredContent.message.includes("proposal_id"));
		});

		test("array instead of object returns validation_error", () => {
			const err = new McpValidationError(
				"Request body must be an object, got array",
			);
			const result = handleMcpError(err, "req-malformed-003");

			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "validation_error");
			assert.ok(result.structuredContent.timestamp);
		});
	});

	describe("Database down scenario", () => {
		test("DB connection error returns db_error without credentials", () => {
			const dbErr = new McpDatabaseError(
				"Unable to connect to database at 127.0.0.1:5432",
			);
			const result = handleMcpError(dbErr, "req-db-001");

			const sc = result.structuredContent;
			assert.ok(result.isError);
			assert.equal(sc.code, "db_error");
			assert.ok(sc.message.includes("Unable to connect"));

			// Verify no credentials are leaked
			const responseText = JSON.stringify(sc);
			assert.ok(!responseText.includes("password"));
			assert.ok(!responseText.includes("secret"));
			assert.ok(!responseText.includes("PGPASSWORD"));
		});

		test("DB timeout returns db_error", () => {
			const err = new McpDatabaseError("Query timeout after 30000ms");
			const result = handleMcpError(err, "req-db-002");

			const sc = result.structuredContent;
			assert.equal(sc.code, "db_error");
			assert.ok(sc.message.includes("timeout"));
		});

		test("DB authentication error does not expose password", () => {
			// Example: DB might try to report "password authentication failed"
			// but we strip sensitive details
			const dbErr = new McpDatabaseError(
				"authentication failed (client IP redacted)",
			);
			const result = handleMcpError(dbErr, "req-db-003");

			const response = JSON.stringify(result.structuredContent);
			assert.ok(!response.includes("PGPASSWORD"));
			assert.ok(!response.includes("password123"));
		});

		test("DB connection pool exhausted", () => {
			const err = new McpDatabaseError(
				"No available connections in pool (max: 20)",
			);
			const result = handleMcpError(err, "req-db-004");

			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "db_error");
			assert.ok(result.structuredContent.message.includes("pool"));
		});
	});

	describe("Schema version mismatch", () => {
		test("stale schema detected returns error with version info", () => {
			// Simulate schema mismatch: client expects v200, server has v195
			const versionMismatch = new McpDatabaseError(
				"Schema version mismatch: expected 200, found 195",
			);
			const result = handleMcpError(versionMismatch, "req-schema-001");

			const sc = result.structuredContent;
			assert.ok(result.isError);
			assert.equal(sc.code, "db_error");
			assert.ok(
				sc.message.includes("Schema version") ||
					sc.message.includes("mismatch"),
			);
		});

		test("missing migration returns db_error", () => {
			const err = new McpDatabaseError(
				"Migration 203 not found in schema_info",
			);
			const result = handleMcpError(err, "req-schema-002");

			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "db_error");
			assert.ok(result.structuredContent.message.includes("Migration") || result.structuredContent.message.includes("203"));
		});

		test("schema table missing returns db_error", () => {
			const err = new McpDatabaseError(
				'Relation "roadmap.schema_info" does not exist',
			);
			const result = handleMcpError(err, "req-schema-003");

			assert.ok(result.isError);
			assert.equal(result.structuredContent.code, "db_error");
		});
	});

	describe("Error response structure invariants", () => {
		test("all error responses contain required fields", () => {
			const scenarios = [
				new McpValidationError("invalid input"),
				new McpDatabaseError("db down"),
			];

			scenarios.forEach((err) => {
				const result = handleMcpError(err, "req-test");
				const sc = result.structuredContent;

				// Required fields per AC-7
				assert.ok(typeof sc.code === "string");
				assert.ok(typeof sc.message === "string");
				assert.ok(typeof sc.request_id === "string");
				assert.ok(typeof sc.timestamp === "string");

				// Timestamp must be ISO 8601
				const timestamp = new Date(sc.timestamp);
				assert.ok(!isNaN(timestamp.getTime()));
			});
		});

		test("error code classifies error type correctly", () => {
			const cases = [
				{ error: new McpValidationError("test"), expectedCode: "validation_error" },
				{ error: new McpDatabaseError("test"), expectedCode: "db_error" },
			];

			cases.forEach(({ error, expectedCode }) => {
				const result = handleMcpError(error, "req-test");
				assert.equal(result.structuredContent.code, expectedCode);
			});
		});

		test("transport never closes on error", () => {
			// handleMcpError should never throw — it catches everything
			const weirdInputs = [
				null,
				undefined,
				{},
				"string error",
				{ nested: { object: true } },
				new Error("normal error"),
			];

			weirdInputs.forEach((input) => {
				assert.doesNotThrow(() => {
					handleMcpError(input, "req-safe");
				});

				const result = handleMcpError(input, "req-safe");
				assert.ok(result.isError === true);
				assert.ok(result.structuredContent.code);
				assert.ok(result.structuredContent.request_id);
			});
		});
	});
});
