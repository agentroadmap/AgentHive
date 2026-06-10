/**
 * Live smoke tests for `hive doctor --check topology`.
 * Gate: RUN_LIVE_SMOKE=1 must be set to run.
 * Requires: agenthive-a2a-host.service active, DB reachable via PGPASSWORD/.pgpass.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const SKIP = !process.env.RUN_LIVE_SMOKE;

describe("doctor --check topology (live smoke)", { skip: SKIP ? "set RUN_LIVE_SMOKE=1 to run" : false }, () => {
  let result: { checks: Array<{ name: string; severity: string; message: string; details?: Record<string, unknown> }> };

  before(async () => {
    const out = execSync(
      "node --import jiti/register src/apps/hive-cli/index.ts doctor --check topology --json",
      { cwd: process.cwd(), stdio: "pipe" },
    ).toString();
    // Doctor outputs JSON envelope to stdout
    const parsed = JSON.parse(out);
    result = parsed.data ?? parsed;
  });

  it("topology check is present in output", () => {
    assert.ok(Array.isArray(result.checks), "result.checks should be an array");
    const topologyCheck = result.checks.find((c) => c.name === "topology");
    assert.ok(topologyCheck, "topology check must be present");
  });

  it("topology severity is ok or warn (not error) on a live system", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    assert.notEqual(
      topologyCheck.severity,
      "error",
      `topology check must not be error on live system — got: ${topologyCheck.message}`,
    );
  });

  it("topology details contains AC-12 spec fields", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown> | undefined;
    assert.ok(d, "details must be present");
    assert.ok("checked_host" in d, "details.checked_host must be present");
    assert.ok("expected_source" in d, "details.expected_source must be present");
    assert.ok("expected_count" in d, "details.expected_count must be present");
    assert.ok("attached_count" in d, "details.attached_count must be present");
    assert.ok("unattached_ids" in d, "details.unattached_ids must be an array");
    assert.ok("legacy_running_count" in d, "details.legacy_running_count must be present");
    assert.ok("mcp_health_latency_ms" in d, "details.mcp_health_latency_ms must be present");
    assert.ok("data_source_errors" in d, "details.data_source_errors must be an array");
  });

  it("checked_host is reported on a live system", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.ok(typeof d.checked_host === "string");
    assert.notEqual(d.checked_host, "");
  });

  it("unattached_ids is empty on a healthy system", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.deepEqual(
      d.unattached_ids,
      [],
      `Unattached agency IDs: ${JSON.stringify(d.unattached_ids)}`,
    );
  });

  it("legacy_running_count is 0 (P1132 migration complete)", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.equal(
      d.legacy_running_count,
      0,
      `Legacy instances still running: ${JSON.stringify(d.legacy_running_count)}`,
    );
  });

  it("--check topology filter returns exactly 1 check", () => {
    assert.equal(
      result.checks.length,
      1,
      `--check topology should filter to 1 check, got ${result.checks.length}`,
    );
  });
});
