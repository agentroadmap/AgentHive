/**
 * P1135 — hermetic topology check logic tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkTopology,
  type TopologyProbers,
} from "../../src/apps/hive-cli/commands/doctor.ts";
import type { HiveContext } from "../../src/apps/hive-cli/common/context.ts";

const CTX: HiveContext = {
  project: "agenthive",
  agency: "codex-test",
  host: "bot",
  mcp_url: "http://127.0.0.1:6421/sse",
  db_host: "127.0.0.1",
  db_port: 5432,
  resolved_at: "2026-05-26T00:00:00.000Z",
};

function probers(overrides: Partial<TopologyProbers> = {}): TopologyProbers {
  return {
    systemctlIsActive: async () => "active",
    listLegacyAgencyUnits: async () => [],
    queryAttachments: async () => [
      { agent_identity: "adam", is_attached: true },
      { agent_identity: "codex-agency-bot", is_attached: true },
    ],
    fetchMcpHealth: async () => ({
      ok: true,
      status: 200,
      body: { status: "ok" },
      latencyMs: 12,
    }),
    ...overrides,
  };
}

function assertDetailsShape(details: Record<string, unknown> | undefined): void {
  assert.ok(details);
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
}

describe("doctor topology check", () => {
  it("returns ok when expected agencies are attached and legacy units are absent", async () => {
    const result = await checkTopology(CTX, probers());

    assert.equal(result.severity, "ok");
    assertDetailsShape(result.details);
    assert.equal(result.details?.checked_host, "bot");
    assert.equal(result.details?.expected_count, 2);
    assert.equal(result.details?.attached_count, 2);
    assert.deepEqual(result.details?.unattached_ids, []);
    assert.equal(result.details?.legacy_running_count, 0);
  });

  it("warns for one or two unattached agencies as a transitional band", async () => {
    const result = await checkTopology(CTX, probers({
      queryAttachments: async () => [
        { agent_identity: "adam", is_attached: true },
        { agent_identity: "codex-agency-bot", is_attached: false },
      ],
    }));

    assert.equal(result.severity, "warn");
    assert.match(result.message, /transitional/);
    assert.deepEqual(result.details?.unattached_ids, ["codex-agency-bot"]);
  });

  it("warns for three or more unattached agencies and reports up to five ids", async () => {
    const result = await checkTopology(CTX, probers({
      queryAttachments: async () => [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
      ].map((agent_identity) => ({ agent_identity, is_attached: false })),
    }));

    assert.equal(result.severity, "warn");
    assert.match(result.message, /6\/6 expected agencies/);
    assert.deepEqual(result.details?.unattached_ids, ["a", "b", "c", "d", "e"]);
  });

  it("warns when legacy agency template instances are still running", async () => {
    const result = await checkTopology(CTX, probers({
      listLegacyAgencyUnits: async () => ["agenthive-agency@adam.service"],
    }));

    assert.equal(result.severity, "warn");
    assert.equal(result.details?.legacy_running_count, 1);
    assert.match(result.message, /Legacy template/);
  });

  it("fails when MCP health does not return status ok", async () => {
    const result = await checkTopology(CTX, probers({
      fetchMcpHealth: async () => ({
        ok: false,
        status: 503,
        body: { status: "starting" },
        error: "health response did not report status=ok",
        latencyMs: 30,
      }),
    }));

    assert.equal(result.severity, "error");
    assert.equal(result.details?.mcp_health_latency_ms, 30);
    assert.match((result.details?.data_source_errors as string[]).join("\n"), /mcp health/);
  });
});
