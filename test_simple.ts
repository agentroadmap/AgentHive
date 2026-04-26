import { test } from "node:test";
import assert from "node:assert";
import { Pool } from "pg";
import { FeatureFlagService } from "./src/shared/runtime/feature-flag-service";

const pool = new Pool({
  host: "127.0.0.1",
  user: "admin",
  password: "YMA3peHGLi6shUTr",
  database: "agenthive",
});

test("AC10 debug: Per-tenant override", async () => {
  try {
    // Initialize service
    FeatureFlagService.initialize(pool);
    
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, per_tenant_override, updated_by)
      VALUES ($1, $2, $3, $4, $5)`,
      [
        "test.tenant_override",
        "Test Tenant Override",
        false,
        JSON.stringify({ agenthive: { enabled: true } }),
        "test",
      ]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // Check DB directly
    const dbCheck = await pool.query(
      `SELECT * FROM roadmap.feature_flag WHERE flag_name = $1`,
      ["test.tenant_override"]
    );
    console.log("DB check:", dbCheck.rows[0]);

    // With tenant slug
    const resolved = await service.resolve("test.tenant_override", {
      projectSlug: "agenthive",
    });
    console.log("Resolved:", resolved);
    assert.strictEqual(resolved.enabled, true, "Override applied");
    assert.strictEqual(
      resolved.reason,
      "per_tenant_override",
      "Reason is per_tenant_override"
    );

    console.log("Test passed!");
  } finally {
    await pool.query(
      "DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'test.%'"
    );
    await pool.end();
  }
});
