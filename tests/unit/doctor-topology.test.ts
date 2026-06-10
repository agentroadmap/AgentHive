/**
 * Hermetic unit tests for the `topology` doctor check.
 * Dependencies (systemctl, DB pool, health probe) are injected via TopologyProbers — no module mocking needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkTopology,
  type TopologyProbers,
} from "../../src/apps/hive-cli/commands/doctor.ts";
import type { HiveContext } from "../../src/apps/hive-cli/common/context.ts";

const BASE_CTX: HiveContext = {
  project: null,
  agency: null,
  host: "bot",
  mcp_url: "http://127.0.0.1:6421/sse",
  db_host: "localhost",
  db_port: 5432,
  resolved_at: new Date().toISOString(),
};

type MockRow = { agent_identity: string; is_attached: boolean };

function makeProbers(opts: {
  inactiveServices?: string[];
  legacyUnits?: string[];
  rows?: MockRow[];
  dbError?: string;
  healthOk?: boolean;
}): TopologyProbers {
  const { inactiveServices = [], legacyUnits = [], rows = [], dbError, healthOk = true } = opts;

  const execSync = (cmd: string, _opts: { stdio: "pipe" }): Buffer => {
    // Check critical services
    for (const svc of [
      "agenthive-mcp.service",
      "agenthive-a2a-host.service",
      "agenthive-board.service",
      "agenthive-state-feed.service",
      "agenthive-notification-router.service",
    ]) {
      if (cmd.includes(`is-active ${svc}`)) {
        if (inactiveServices.includes(svc)) throw new Error("inactive");
        return Buffer.from("active\n");
      }
    }
    if (cmd.includes("list-units")) {
      if (legacyUnits.length === 0) return Buffer.from("");
      return Buffer.from(legacyUnits.map((u) => `${u} loaded active running`).join("\n") + "\n");
    }
    return Buffer.from("");
  };

  const poolQuery = async (_sql: string, _params: unknown[]) => {
    if (dbError) throw new Error(dbError);
    return { rows };
  };

  const probeHealth = async (_url: string, _timeoutMs: number) => {
    if (healthOk) {
      return { ok: true, latencyMs: 45, error: undefined };
    }
    return { ok: false, latencyMs: 1000, error: "connection refused" };
  };

  return { execSync, poolQuery, probeHealth };
}

describe("checkTopology", () => {
  it("returns ok when all agencies attached, all services active, no legacy instances", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "claude-agency-bot", is_attached: true },
        { agent_identity: "gemini-agency-george", is_attached: true },
      ],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.name, "topology");
    assert.equal(result.severity, "ok");
    assert.match(result.message, /2 expected agencies attached/);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.unattached_ids, []);
    assert.equal(details.legacy_running_count, 0);
  });

  it("returns error when critical service is inactive (AC-2)", async () => {
    const probers = makeProbers({ inactiveServices: ["agenthive-mcp.service"] });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "error");
    assert.match(result.message, /agenthive-mcp\.service/);
    assert.match(result.remediation ?? "", /systemctl start/);
  });

  it("returns error when MCP /health fails (AC-5)", async () => {
    const probers = makeProbers({ healthOk: false });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "error");
    assert.match(result.message, /MCP.*health/i);
    assert.match(result.remediation ?? "", /systemctl restart/);
  });

  it("returns warn when 1-2 agencies unattached (AC-3 transitional)", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "claude-agency-bot", is_attached: true },
        { agent_identity: "gemini-agency-george", is_attached: false },
      ],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    assert.match(result.message, /transitional/);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.unattached_ids, ["gemini-agency-george"]);
  });

  it("returns warn when ≥3 agencies unattached (AC-3)", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "a", is_attached: true },
        { agent_identity: "b", is_attached: false },
        { agent_identity: "c", is_attached: false },
        { agent_identity: "d", is_attached: false },
      ],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    assert.match(result.message, /3\/4/);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.unattached_ids, ["b", "c", "d"]);
  });

  it("returns warn when legacy template instances running (AC-4)", async () => {
    const probers = makeProbers({
      rows: [{ agent_identity: "claude-agency-bot", is_attached: true }],
      legacyUnits: ["agenthive-agency@old-agent.service"],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    assert.match(result.message, /Legacy agenthive-agency@/);
    assert.match(result.remediation ?? "", /systemctl stop/);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.legacy_running_count, 1);
  });

  it("includes data_source_errors in details when DB query fails", async () => {
    const probers = makeProbers({ dbError: "connection refused" });
    const result = await checkTopology(BASE_CTX, probers);

    const details = result.details as Record<string, unknown>;
    assert.ok(Array.isArray(details.data_source_errors));
    assert.match((details.data_source_errors as string[])[0], /agency_registry query/);
  });

  it("details shape satisfies AC-12 contract (8 required fields)", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "a", is_attached: true },
        { agent_identity: "b", is_attached: false },
      ],
    });
    const result = await checkTopology({ ...BASE_CTX, host: "testhost" }, probers);

    const d = result.details as Record<string, unknown>;
    assert.equal(d.checked_host, "testhost");
    assert.equal(d.expected_source, "agent_registry.host_affinity");
    assert.ok(typeof d.expected_count === "number");
    assert.ok(typeof d.attached_count === "number");
    assert.ok(Array.isArray(d.unattached_ids));
    assert.ok(typeof d.legacy_running_count === "number");
    assert.ok(typeof d.mcp_health_latency_ms === "number");
    assert.ok(Array.isArray(d.data_source_errors));
  });

  it("DoctorCheck shape has required fields", async () => {
    const probers = makeProbers({});
    const result = await checkTopology(BASE_CTX, probers);

    assert.ok("name" in result);
    assert.ok("severity" in result);
    assert.ok("message" in result);
    assert.ok(["ok", "warn", "error"].includes(result.severity));
  });

  it("unattached_ids truncates beyond 5 with remaining count separate", async () => {
    const probers = makeProbers({
      rows: Array.from({ length: 8 }, (_, i) => ({
        agent_identity: `agency-${i}`,
        is_attached: i === 0,
      })),
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    const details = result.details as Record<string, unknown>;
    assert.equal((details.unattached_ids as string[]).length, 5, "Should include max 5 unattached IDs");
  });

  it("uses os.hostname() fallback when ctx.host is missing", async () => {
    const probers = makeProbers({
      rows: [{ agent_identity: "test-agency", is_attached: true }],
    });
    const ctxNoHost = { ...BASE_CTX, host: "" };
    const result = await checkTopology(ctxNoHost, probers);

    const details = result.details as Record<string, unknown>;
    assert.ok(typeof details.checked_host === "string");
    assert.notEqual(details.checked_host, "");
  });
});
