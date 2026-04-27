/**
 * Test envelope builder per cli-hive-contract.md §2.
 *
 * Validates that success and error envelopes conform to the schema.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  successEnvelope,
  errorEnvelope,
  HiveError,
  Errors,
} from "../apps/hive-cli/common/index";

test("successEnvelope builds correct structure", () => {
  const data = { id: "P123", title: "Test Proposal", state: "DRAFT" };
  const context = {
    project: "agenthive",
    agency: "hermes/agency-xiaomi",
    host: "hermes",
    resolved_at: "2026-04-25T14:30:00Z",
  };

  const envelope = successEnvelope(data, "hive proposal get", context, {
    elapsed_ms: 100,
  });

  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.command, "hive proposal get");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, data);
  assert.equal(envelope.elapsed_ms, 100);
  assert.equal(envelope.context.project, "agenthive");
  assert(!("error" in envelope));
});

test("errorEnvelope builds correct structure for HiveError", () => {
  const error = new HiveError("NOT_FOUND", "Proposal P999 does not exist", {
    hint: "Run `hive proposal list` to see available IDs",
    detail: { proposal_id: "P999", project: "agenthive" },
  });

  const context = {
    project: "agenthive",
    resolved_at: "2026-04-25T14:30:00Z",
  };

  const envelope = errorEnvelope(error, "hive proposal get P999", context, {
    elapsed_ms: 50,
  });

  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.command, "hive proposal get P999");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "NOT_FOUND");
  assert.equal(envelope.error.message, "Proposal P999 does not exist");
  assert.equal(envelope.error.hint, "Run `hive proposal list` to see available IDs");
  assert.deepEqual(envelope.error.detail, {
    proposal_id: "P999",
    project: "agenthive",
  });
  assert.equal(envelope.error.retriable, false);
  assert.equal(envelope.error.exit_code, 2);
  assert.equal(envelope.elapsed_ms, 50);
  assert(!("data" in envelope));
});

test("Errors.usage throws HiveError with USAGE code", () => {
  const error = Errors.usage("Missing required flag: --title");
  assert.equal(error.code, "USAGE");
  assert.equal(error.exitCode, 1);
  assert.equal(error.retriable, false);
});

test("Errors.mcpUnreachable throws HiveError with MCP_UNREACHABLE code", () => {
  const error = Errors.mcpUnreachable(
    "MCP server at http://127.0.0.1:6421/sse unreachable",
    "Check that agenthive-mcp.service is running"
  );
  assert.equal(error.code, "MCP_UNREACHABLE");
  assert.equal(error.exitCode, 12);
  assert.equal(error.retriable, true);
  assert.equal(error.hint, "Check that agenthive-mcp.service is running");
});

test("successListEnvelope includes next_cursor for pagination", async () => {
  const { successListEnvelope } = await import(
    "../apps/hive-cli/common/index"
  );
  const items = [
    { id: "P001", title: "Proposal 1" },
    { id: "P002", title: "Proposal 2" },
  ];
  const context = { project: "agenthive", resolved_at: new Date().toISOString() };

  const envelope = successListEnvelope(items, "hive proposal list", context, {
    next_cursor: "cursor-abc123",
    elapsed_ms: 234,
  });

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, items);
  assert.equal(envelope.next_cursor, "cursor-abc123");
});

test("Error envelope uses correct exit code mapping", () => {
  const testCases = [
    {
      error: Errors.usage("test"),
      expectedCode: 1,
    },
    {
      error: Errors.notFound("test"),
      expectedCode: 2,
    },
    {
      error: Errors.conflict("test"),
      expectedCode: 4,
    },
    {
      error: Errors.remoteFailure("test"),
      expectedCode: 5,
    },
    {
      error: Errors.invalidState("test"),
      expectedCode: 6,
    },
  ];

  const context = { resolved_at: new Date().toISOString() };

  for (const { error, expectedCode } of testCases) {
    const envelope = errorEnvelope(error, "test-cmd", context);
    assert.equal(
      envelope.error.exit_code,
      expectedCode,
      `Error ${error.code} should map to exit code ${expectedCode}`
    );
  }
});
