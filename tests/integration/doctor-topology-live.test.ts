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

  it("topology details contains expected shape fields", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown> | undefined;
    assert.ok(d, "details must be present");
    assert.ok("host" in d, "details.host must be present");
    assert.ok("a2a_host_service" in d, "details.a2a_host_service must be present");
    assert.ok("expected_agencies" in d, "details.expected_agencies must be present");
    assert.ok("attached_agencies" in d, "details.attached_agencies must be present");
    assert.ok(Array.isArray(d.unattached), "details.unattached must be an array");
    assert.ok(
      Array.isArray(d.legacy_template_instances),
      "details.legacy_template_instances must be an array",
    );
  });

  it("a2a_host_service is 'active' on a live system", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.equal(d.a2a_host_service, "active");
  });

  it("unattached array is empty on a healthy system", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.deepEqual(d.unattached, [], `Unattached agencies: ${JSON.stringify(d.unattached)}`);
  });

  it("legacy_template_instances is empty (P1132 migration complete)", () => {
    const topologyCheck = result.checks.find((c) => c.name === "topology")!;
    const d = topologyCheck.details as Record<string, unknown>;
    assert.deepEqual(
      d.legacy_template_instances,
      [],
      `Legacy instances still running: ${JSON.stringify(d.legacy_template_instances)}`,
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
