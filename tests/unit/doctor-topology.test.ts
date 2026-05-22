/**
 * Hermetic unit tests for the `topology` doctor check.
 * Dependencies (systemctl, DB pool) are injected via TopologyProbers — no module mocking needed.
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
  a2aStatus?: string;
  legacyUnits?: string[];
  rows?: MockRow[];
  dbError?: string;
}): TopologyProbers {
  const { a2aStatus = "active", legacyUnits = [], rows = [], dbError } = opts;

  const execSync = (cmd: string, _opts: { stdio: "pipe" }): Buffer => {
    if (cmd.includes("is-active")) {
      if (a2aStatus !== "active") throw new Error("inactive");
      return Buffer.from("active\n");
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

  return { execSync, poolQuery };
}

describe("checkTopology", () => {
  it("returns ok when all agencies attached and no legacy instances", async () => {
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
    assert.deepEqual((result.details as Record<string, unknown>).unattached, []);
    assert.deepEqual(
      (result.details as Record<string, unknown>).legacy_template_instances,
      [],
    );
  });

  it("returns error when a2a-host.service is inactive", async () => {
    const probers = makeProbers({ a2aStatus: "inactive" });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "error");
    assert.match(result.message, /agenthive-a2a-host\.service/);
    assert.match(result.remediation ?? "", /systemctl start/);
  });

  it("returns error when some agencies are not attached", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "claude-agency-bot", is_attached: true },
        { agent_identity: "gemini-agency-george", is_attached: false },
        { agent_identity: "hermes-agency-one", is_attached: false },
      ],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "error");
    assert.match(result.message, /2\/3 expected agencies not attached/);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.unattached, ["gemini-agency-george", "hermes-agency-one"]);
    assert.equal(details.expected_agencies, 3);
    assert.equal(details.attached_agencies, 1);
  });

  it("returns warn when legacy template instances are running", async () => {
    const probers = makeProbers({
      rows: [{ agent_identity: "claude-agency-bot", is_attached: true }],
      legacyUnits: ["agenthive-agency@old-agent.service"],
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    assert.match(result.message, /Legacy agenthive-agency@/);
    assert.match(result.remediation ?? "", /systemctl stop/);
    const details = result.details as Record<string, unknown>;
    assert.deepEqual(details.legacy_template_instances, [
      "agenthive-agency@old-agent.service",
    ]);
  });

  it("returns warn (not error) when DB query fails but a2a-host is active", async () => {
    const probers = makeProbers({ dbError: "connection refused" });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "warn");
    assert.match(result.message, /attachment query failed/);
    const details = result.details as Record<string, unknown>;
    assert.ok((details.db_error as string).includes("connection refused"));
  });

  it("details shape satisfies AC-12 contract", async () => {
    const probers = makeProbers({
      rows: [
        { agent_identity: "a", is_attached: true },
        { agent_identity: "b", is_attached: false },
      ],
    });
    const result = await checkTopology({ ...BASE_CTX, host: "testhost" }, probers);

    const d = result.details as Record<string, unknown>;
    assert.equal(d.host, "testhost");
    assert.ok(typeof d.a2a_host_service === "string");
    assert.ok(typeof d.expected_agencies === "number");
    assert.ok(typeof d.attached_agencies === "number");
    assert.ok(Array.isArray(d.unattached));
    assert.ok(Array.isArray(d.legacy_template_instances));
  });

  it("DoctorCheck shape has required fields", async () => {
    const probers = makeProbers({});
    const result = await checkTopology(BASE_CTX, probers);

    assert.ok("name" in result);
    assert.ok("severity" in result);
    assert.ok("message" in result);
    assert.ok(["ok", "warn", "error"].includes(result.severity));
  });

  it("error message truncates unattached list beyond 5 with +N more suffix", async () => {
    const probers = makeProbers({
      rows: Array.from({ length: 8 }, (_, i) => ({
        agent_identity: `agency-${i}`,
        is_attached: false,
      })),
    });
    const result = await checkTopology(BASE_CTX, probers);

    assert.equal(result.severity, "error");
    assert.match(result.message, /\+3 more/);
  });
});
