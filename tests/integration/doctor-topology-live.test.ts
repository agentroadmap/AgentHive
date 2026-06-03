/**
 * P1135 — opt-in live smoke for `hive doctor --check topology --json`.
 *
 * Run with RUN_LIVE_SMOKE=1 when the local AgentHive runtime is available.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const runLive = process.env.RUN_LIVE_SMOKE === "1";

describe("doctor topology live smoke", { skip: runLive ? false : "set RUN_LIVE_SMOKE=1 to run live topology smoke" }, () => {
  it("returns the topology check with structured observability fields", async () => {
    let stdout = "";
    let exitCode = 0;
    try {
      const result = await execFileAsync(
        process.execPath,
        ["--import", "jiti/register", "src/apps/hive-cli/index.ts", "doctor", "--check", "topology", "--json"],
        {
          cwd: process.cwd(),
          env: { ...process.env, AGENTHIVE_HOST: process.env.AGENTHIVE_HOST ?? "bot" },
          timeout: 5000,
        },
      );
      stdout = result.stdout;
    } catch (err) {
      const error = err as { stdout?: string; code?: number };
      stdout = error.stdout ?? "";
      exitCode = error.code ?? 1;
    }

    const envelope = JSON.parse(stdout);
    const checks = envelope.data?.checks;
    assert.equal(Array.isArray(checks), true);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, "topology");
    assert.ok([0, 1].includes(exitCode), "live smoke allows healthy or warning topology state");

    const details = checks[0].details;
    const expectedHost = process.env.AGENTHIVE_HOST ?? "bot";
    assert.equal(details.checked_host, expectedHost);
    for (const key of [
      "checked_host",
      "expected_source",
      "expected_count",
      "attached_count",
      "unattached_ids",
      "legacy_running_count",
      "mcp_health_latency_ms",
      "data_source_errors",
    ]) {
      assert.ok(key in details, `missing details.${key}`);
    }
  });
});
