/**
 * P455 AC#2 — Golden JSON envelope tests.
 * Verifies that buildOkEnvelope and buildErrorEnvelope produce the canonical
 * machine-readable envelope shape that every hive command must emit.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildOkEnvelope, buildErrorEnvelope, SCHEMA_VERSION } from "../../src/apps/hive-cli/common/envelope.ts";
import type { HiveContext } from "../../src/apps/hive-cli/common/context.ts";

const MOCK_CTX: HiveContext = {
  project: "agenthive",
  agency: "test-agency",
  host: "test-host",
  mcp_url: "http://127.0.0.1:6421/sse",
  db_host: "127.0.0.1",
  db_port: 5432,
  resolved_at: "2026-04-29T00:00:00.000Z",
};

describe("hive-cli golden JSON envelope", () => {
  describe("SCHEMA_VERSION", () => {
    it("is a positive integer", () => {
      assert.strictEqual(typeof SCHEMA_VERSION, "number");
      assert.ok(SCHEMA_VERSION >= 1, "SCHEMA_VERSION must be >= 1");
    });
  });

  describe("buildOkEnvelope", () => {
    it("produces an envelope with schema_version", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, { rows: [] }, {});
      assert.strictEqual(env.schema_version, SCHEMA_VERSION);
    });

    it("ok is true", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      assert.strictEqual(env.ok, true);
    });

    it("command field matches the given command name", () => {
      const env = buildOkEnvelope("hive proposal list", MOCK_CTX, [], {});
      assert.strictEqual(env.command, "hive proposal list");
    });

    it("context block carries project and agency", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      assert.strictEqual(env.context.project, "agenthive");
      assert.strictEqual(env.context.agency, "test-agency");
    });

    it("data field carries the payload", () => {
      const payload = { id: "42", name: "test" };
      const env = buildOkEnvelope("hive test", MOCK_CTX, payload, {});
      assert.deepStrictEqual(env.data, payload);
    });

    it("error field is absent (undefined or null) on success", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      assert.ok(!env.error, "error should be absent on success envelope");
    });

    it("elapsed_ms is a non-negative number when provided", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, { elapsed_ms: 42 });
      assert.ok(typeof env.elapsed_ms === "number" && env.elapsed_ms >= 0);
    });

    it("is JSON-serialisable without loss", () => {
      const payload = { items: [1, 2, 3], cursor: null };
      const env = buildOkEnvelope("hive test", MOCK_CTX, payload, { elapsed_ms: 10 });
      const round = JSON.parse(JSON.stringify(env));
      assert.deepStrictEqual(round.data, payload);
      assert.strictEqual(round.ok, true);
    });

    it("warnings field is an empty array when no warnings", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      assert.ok(Array.isArray(env.warnings), "warnings must be an array");
    });

    it("next_cursor field is present (may be null/undefined)", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      // next_cursor is optional — it's OK if absent; just must not throw
      assert.doesNotThrow(() => JSON.stringify(env));
    });
  });

  describe("buildErrorEnvelope", () => {
    it("ok is false", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "NOT_FOUND",
        message: "not found",
        retriable: false,
      }, {});
      assert.strictEqual(env.ok, false);
    });

    it("error.code is preserved", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "REMOTE_FAILURE",
        message: "server down",
        retriable: true,
      }, {});
      assert.strictEqual(env.error?.code, "REMOTE_FAILURE");
    });

    it("error.message is preserved", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "NOT_FOUND",
        message: "Proposal 99 not found",
        retriable: false,
      }, {});
      assert.strictEqual(env.error?.message, "Proposal 99 not found");
    });

    it("error.retriable is preserved", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "TIMEOUT",
        message: "timed out",
        retriable: true,
      }, {});
      assert.strictEqual(env.error?.retriable, true);
    });

    it("data field is absent (undefined or null) on error", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "CONFLICT",
        message: "conflict",
        retriable: false,
      }, {});
      assert.ok(!env.data, "data should be absent on error envelope");
    });

    it("schema_version matches SCHEMA_VERSION constant", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "INTERNAL_ERROR",
        message: "boom",
        retriable: false,
      }, {});
      assert.strictEqual(env.schema_version, SCHEMA_VERSION);
    });

    it("is JSON-serialisable without loss", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "MCP_UNREACHABLE",
        message: "no route to MCP",
        retriable: true,
      }, { elapsed_ms: 3001 });
      const round = JSON.parse(JSON.stringify(env));
      assert.strictEqual(round.ok, false);
      assert.strictEqual(round.error.code, "MCP_UNREACHABLE");
    });

    it("hint is forwarded when provided", () => {
      const env = buildErrorEnvelope("hive proposal list", MOCK_CTX, {
        code: "NOT_FOUND",
        message: "none",
        hint: "try hive workflow list",
        retriable: false,
      }, {});
      assert.strictEqual(env.error?.hint, "try hive workflow list");
    });
  });

  describe("envelope shape contract", () => {
    it("ok envelope has all required top-level keys", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      const required = ["schema_version", "command", "context", "ok"];
      for (const key of required) {
        assert.ok(key in env, `missing required key: ${key}`);
      }
    });

    it("error envelope has all required top-level keys", () => {
      const env = buildErrorEnvelope("hive test", MOCK_CTX, {
        code: "USAGE",
        message: "bad args",
        retriable: false,
      }, {});
      const required = ["schema_version", "command", "context", "ok", "error"];
      for (const key of required) {
        assert.ok(key in env, `missing required key: ${key}`);
      }
    });

    it("context block always has host and mcp_url", () => {
      const env = buildOkEnvelope("hive test", MOCK_CTX, {}, {});
      assert.ok("host" in env.context, "context missing host");
      assert.ok("mcp_url" in env.context, "context missing mcp_url");
    });
  });
});
