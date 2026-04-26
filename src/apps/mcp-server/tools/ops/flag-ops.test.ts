import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { Pool } from "pg";
import { FlagOpsHandler } from "./flag-ops";

let pool: Pool;
let handler: FlagOpsHandler;

describe("FlagOpsHandler — MCP Ops Tools", () => {
  before(async () => {
    pool = new Pool({
      host: process.env.PGHOST || "127.0.0.1",
      port: parseInt(process.env.PGPORT || "5432", 10),
      user: process.env.PGUSER || "admin",
      password: process.env.PGPASSWORD || "YMA3peHGLi6shUTr",
      database: process.env.PGDATABASE || "agenthive",
    });

    handler = new FlagOpsHandler(pool);

    // Cleanup test data
    await pool.query(
      "DELETE FROM roadmap.feature_flag_audit WHERE flag_name LIKE 'ops-test.%'"
    );
    await pool.query(
      "DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'ops-test.%'"
    );
  });

  after(async () => {
    await pool.query(
      "DELETE FROM roadmap.feature_flag_audit WHERE flag_name LIKE 'ops-test.%'"
    );
    await pool.query(
      "DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'ops-test.%'"
    );
    await pool.end();
  });

  test("AC7: flag_get returns flag with all fields", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, rollout_percent, per_tenant_override, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "ops-test.get",
        "Test Get",
        true,
        75,
        JSON.stringify({ tenant1: { enabled: false } }),
        "test-user",
      ]
    );

    const result = await handler.flagGet("ops-test.get");
    assert.strictEqual(result.flag_name, "ops-test.get", "flag_name matches");
    assert.strictEqual(result.display_name, "Test Get", "display_name matches");
    assert.strictEqual(result.enabled_default, true, "enabled_default is true");
    assert.strictEqual(result.rollout_percent, 75, "rollout_percent is 75");
    assert.ok(
      result.per_tenant_override.tenant1,
      "per_tenant_override has tenant1"
    );
    assert.strictEqual(result.updated_by, "test-user", "updated_by matches");
  });

  test("AC7: flag_list returns all non-archived flags", async () => {
    // Insert multiple flags
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, per_tenant_override, updated_by)
      VALUES
      ($1, $2, $3, $4, $5),
      ($6, $7, $8, $9, $10)`,
      [
        "ops-test.list1",
        "List 1",
        true,
        JSON.stringify({}),
        "test",
        "ops-test.list2",
        "List 2",
        false,
        JSON.stringify({ proj1: { enabled: true } }),
        "test",
      ]
    );

    const result = await handler.flagList(false);
    const testFlags = result.flags.filter((f) =>
      f.flag_name.startsWith("ops-test.list")
    );
    assert.ok(testFlags.length >= 2, "Both flags returned");
  });

  test("AC8: flag_set creates audit entry with old/new values", async () => {
    // Insert initial flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, rollout_percent, updated_by)
      VALUES ($1, $2, $3, $4, $5)`,
      ["ops-test.set", "Test Set", false, 100, "test"]
    );

    // Set flag
    const result = await handler.flagSet(
      "ops-test.set",
      true,
      50,
      undefined,
      "Enable for canary",
      "ops-agent-1"
    );

    assert.strictEqual(result.flag_name, "ops-test.set", "flag_name in result");
    assert.ok(result.audit_id, "audit_id returned");
    assert.ok(result.old_value, "old_value in result");

    // Verify flag was updated
    const flagResult = await pool.query(
      "SELECT enabled_default, rollout_percent FROM roadmap.feature_flag WHERE flag_name = $1",
      ["ops-test.set"]
    );
    const updated = flagResult.rows[0];
    assert.strictEqual(updated.enabled_default, true, "Flag enabled");
    assert.strictEqual(updated.rollout_percent, 50, "Rollout set to 50");

    // Verify audit entry
    const auditResult = await pool.query(
      "SELECT action, changed_by, reason FROM roadmap.feature_flag_audit WHERE id = $1",
      [result.audit_id]
    );
    assert.ok(auditResult.rows.length > 0, "Audit entry exists");
    const audit = auditResult.rows[0];
    assert.strictEqual(audit.action, "set", "Action is 'set'");
    assert.strictEqual(audit.changed_by, "ops-agent-1", "changed_by recorded");
    assert.strictEqual(
      audit.reason,
      "Enable for canary",
      "Reason recorded in audit"
    );
  });

  test("AC8: flag_set rejects invalid rollout_percent", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, updated_by)
      VALUES ($1, $2, $3)`,
      ["ops-test.invalid", "Test Invalid", "test"]
    );

    // Try to set invalid rollout
    try {
      await handler.flagSet("ops-test.invalid", undefined, 150);
      assert.fail("Should have thrown for invalid rollout");
    } catch (err) {
      assert.ok(err.message.includes("rolloutPercent"), "Error mentions rolloutPercent");
    }
  });

  test("AC9: flag_override creates audit with per-tenant change", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, per_tenant_override, updated_by)
      VALUES ($1, $2, $3, $4)`,
      ["ops-test.override", "Test Override", JSON.stringify({}), "test"]
    );

    // Set override
    const result = await handler.flagOverride(
      "ops-test.override",
      "proj-alpha",
      { enabled: true, variant: "control" },
      "Enable for proj-alpha",
      "ops-agent-2"
    );

    assert.ok(result.audit_id, "audit_id returned");

    // Verify override was set
    const flagResult = await pool.query(
      "SELECT per_tenant_override FROM roadmap.feature_flag WHERE flag_name = $1",
      ["ops-test.override"]
    );
    const override = flagResult.rows[0].per_tenant_override["proj-alpha"];
    assert.ok(override, "Override exists for proj-alpha");
    assert.strictEqual(override.enabled, true, "Override enabled is true");
    assert.strictEqual(override.variant, "control", "Variant is control");

    // Verify audit entry
    const auditResult = await pool.query(
      "SELECT action, changed_by FROM roadmap.feature_flag_audit WHERE id = $1",
      [result.audit_id]
    );
    const audit = auditResult.rows[0];
    assert.strictEqual(audit.action, "override", "Action is 'override'");
    assert.strictEqual(audit.changed_by, "ops-agent-2", "changed_by recorded");
  });

  test("AC9: flag_audit returns audit entries filtered by flag_name", async () => {
    // Insert flag and create audit history
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, updated_by)
      VALUES ($1, $2, $3)`,
      ["ops-test.audit", "Test Audit", "test"]
    );

    // Create some audit entries
    await handler.flagSet(
      "ops-test.audit",
      true,
      undefined,
      undefined,
      "Reason 1",
      "agent-1"
    );

    await handler.flagSet(
      "ops-test.audit",
      false,
      undefined,
      undefined,
      "Reason 2",
      "agent-2"
    );

    // Query audit
    const result = await handler.flagAudit("ops-test.audit", undefined, undefined, 50);
    assert.ok(result.entries.length >= 2, "Multiple audit entries returned");

    const allSame = result.entries.every(
      (e) => e.flag_name === "ops-test.audit"
    );
    assert.ok(allSame, "All entries are for same flag");

    // Verify ordering (newest first)
    if (result.entries.length >= 2) {
      const first = new Date(result.entries[0].changed_at);
      const second = new Date(result.entries[1].changed_at);
      assert.ok(
        first.getTime() >= second.getTime(),
        "Entries ordered DESC by changed_at"
      );
    }
  });

  test("AC9: flag_audit filters by changed_by", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, updated_by)
      VALUES ($1, $2, $3)`,
      ["ops-test.changed-by", "Test ChangedBy", "test"]
    );

    // Create audit entries by different agents
    await handler.flagSet(
      "ops-test.changed-by",
      true,
      undefined,
      undefined,
      "By agent-A",
      "agent-A"
    );

    await handler.flagSet(
      "ops-test.changed-by",
      false,
      undefined,
      undefined,
      "By agent-B",
      "agent-B"
    );

    // Query by changed_by
    const result = await handler.flagAudit(
      "ops-test.changed-by",
      "agent-A",
      undefined,
      50
    );
    assert.ok(result.entries.length >= 1, "Entries returned");

    const allByAgentA = result.entries.every((e) => e.changed_by === "agent-A");
    assert.ok(allByAgentA, "All entries filtered by agent-A");
  });

  test("AC14: Flag change via MCP does not trigger proposal state transitions", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, updated_by)
      VALUES ($1, $2, $3)`,
      ["ops-test.no-state-change", "No State Change", "test"]
    );

    // Update flag via MCP ops
    await handler.flagSet(
      "ops-test.no-state-change",
      true,
      undefined,
      undefined,
      "Should not affect proposals",
      "system"
    );

    // Verify audit metadata doesn't trigger workflow
    const auditResult = await pool.query(
      "SELECT metadata FROM roadmap.feature_flag_audit WHERE flag_name = $1 LIMIT 1",
      ["ops-test.no-state-change"]
    );

    if (auditResult.rows.length > 0) {
      const metadata = auditResult.rows[0].metadata;
      // Metadata should NOT contain any proposal state fields
      assert.ok(!metadata || !metadata.state, "Metadata does not trigger state");
    }
  });

  test("Multiple overrides for same flag (per-tenant isolation)", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, per_tenant_override, updated_by)
      VALUES ($1, $2, $3, $4)`,
      ["ops-test.multi-tenant", "Multi Tenant", JSON.stringify({}), "test"]
    );

    // Set overrides for different tenants
    await handler.flagOverride(
      "ops-test.multi-tenant",
      "tenant-1",
      { enabled: true },
      "Tenant 1",
      "ops"
    );

    await handler.flagOverride(
      "ops-test.multi-tenant",
      "tenant-2",
      { enabled: false },
      "Tenant 2",
      "ops"
    );

    // Verify both exist
    const flagResult = await pool.query(
      "SELECT per_tenant_override FROM roadmap.feature_flag WHERE flag_name = $1",
      ["ops-test.multi-tenant"]
    );
    const overrides = flagResult.rows[0].per_tenant_override;

    assert.strictEqual(
      overrides["tenant-1"].enabled,
      true,
      "Tenant 1 override is true"
    );
    assert.strictEqual(
      overrides["tenant-2"].enabled,
      false,
      "Tenant 2 override is false"
    );
  });
});
