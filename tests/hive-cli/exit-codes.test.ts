/**
 * P455 AC#2 — Exit-code contract tests.
 * Verifies the stable 0..99 exit-code enum, ERROR_CODE enum, and the mapping between them.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  EXIT,
  ERROR_CODE,
  ERROR_CODE_TO_EXIT,
  exitCodeForError,
} from "../../src/apps/hive-cli/common/exit-codes.ts";

describe("hive-cli exit-code contract", () => {
  it("EXIT.OK is 0", () => {
    assert.strictEqual(EXIT.OK, 0);
  });

  it("EXIT.USAGE is 1", () => {
    assert.strictEqual(EXIT.USAGE, 1);
  });

  it("EXIT.NOT_FOUND is 2", () => {
    assert.strictEqual(EXIT.NOT_FOUND, 2);
  });

  it("EXIT.PERMISSION_DENIED is 3", () => {
    assert.strictEqual(EXIT.PERMISSION_DENIED, 3);
  });

  it("EXIT.CONFLICT is 4", () => {
    assert.strictEqual(EXIT.CONFLICT, 4);
  });

  it("EXIT.REMOTE_FAILURE is 5", () => {
    assert.strictEqual(EXIT.REMOTE_FAILURE, 5);
  });

  it("EXIT.INVALID_STATE is 6", () => {
    assert.strictEqual(EXIT.INVALID_STATE, 6);
  });

  it("EXIT.BUDGET_EXHAUSTED is 7", () => {
    assert.strictEqual(EXIT.BUDGET_EXHAUSTED, 7);
  });

  it("EXIT.POLICY_DENIED is 8", () => {
    assert.strictEqual(EXIT.POLICY_DENIED, 8);
  });

  it("EXIT.TIMEOUT is 9", () => {
    assert.strictEqual(EXIT.TIMEOUT, 9);
  });

  it("EXIT.RATE_LIMITED is 10", () => {
    assert.strictEqual(EXIT.RATE_LIMITED, 10);
  });

  it("EXIT.SCHEMA_DRIFT is 11", () => {
    assert.strictEqual(EXIT.SCHEMA_DRIFT, 11);
  });

  it("EXIT.MCP_UNREACHABLE is 12", () => {
    assert.strictEqual(EXIT.MCP_UNREACHABLE, 12);
  });

  it("EXIT.DB_UNREACHABLE is 13", () => {
    assert.strictEqual(EXIT.DB_UNREACHABLE, 13);
  });

  it("EXIT.ENCODING_ERROR is 14", () => {
    assert.strictEqual(EXIT.ENCODING_ERROR, 14);
  });

  it("EXIT.INTERNAL_ERROR is 99", () => {
    assert.strictEqual(EXIT.INTERNAL_ERROR, 99);
  });

  it("ERROR_CODE enum contains all expected codes", () => {
    const expected = [
      "USAGE",
      "NOT_FOUND",
      "PERMISSION_DENIED",
      "CONFLICT",
      "REMOTE_FAILURE",
      "INVALID_STATE",
      "BUDGET_EXHAUSTED",
      "POLICY_DENIED",
      "TIMEOUT",
      "RATE_LIMITED",
      "SCHEMA_DRIFT",
      "MCP_UNREACHABLE",
      "DB_UNREACHABLE",
      "ENCODING_ERROR",
      "INTERNAL_ERROR",
    ];
    for (const code of expected) {
      assert.ok(code in ERROR_CODE, `ERROR_CODE missing: ${code}`);
    }
  });

  it("ERROR_CODE_TO_EXIT covers every ERROR_CODE value", () => {
    for (const [key, code] of Object.entries(ERROR_CODE)) {
      assert.ok(
        code in ERROR_CODE_TO_EXIT,
        `ERROR_CODE_TO_EXIT missing mapping for ${key} (${code})`,
      );
    }
  });

  it("exitCodeForError(ERROR_CODE.NOT_FOUND) returns EXIT.NOT_FOUND", () => {
    assert.strictEqual(exitCodeForError(ERROR_CODE.NOT_FOUND), EXIT.NOT_FOUND);
  });

  it("exitCodeForError(ERROR_CODE.MCP_UNREACHABLE) returns EXIT.MCP_UNREACHABLE", () => {
    assert.strictEqual(exitCodeForError(ERROR_CODE.MCP_UNREACHABLE), EXIT.MCP_UNREACHABLE);
  });

  it("exitCodeForError(ERROR_CODE.USAGE) returns EXIT.USAGE", () => {
    assert.strictEqual(exitCodeForError(ERROR_CODE.USAGE), EXIT.USAGE);
  });

  it("no two ERROR_CODEs map to the same exit code (except OK) — codes are stable identifiers", () => {
    const seen = new Map<number, string>();
    for (const [key, code] of Object.entries(ERROR_CODE)) {
      const exit = ERROR_CODE_TO_EXIT[code as keyof typeof ERROR_CODE_TO_EXIT];
      if (seen.has(exit)) {
        assert.fail(`Exit code ${exit} is shared by ${seen.get(exit)} and ${key}`);
      }
      seen.set(exit, key);
    }
  });
});
