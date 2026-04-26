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

test("AC10 debug", async () => {
  try {
    const flagName = "test.ac10_debug_" + Date.now();
    
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, per_tenant_override, updated_by)
      VALUES ($1, $2, $3, $4, $5)`,
      [
        flagName,
        "Test Tenant Override",
        false,
        JSON.stringify({ agenthive: { enabled: true } }),
        "test",
      ]
    );

    FeatureFlagService.reset();
    FeatureFlagService.initialize(pool);
    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // Check DB
    const dbCheck = await pool.query(
      "SELECT enabled_default FROM roadmap.feature_flag WHERE flag_name = $1",
      [flagName]
    );
    console.log("DB enabled_default:", dbCheck.rows[0].enabled_default);

    // With tenant slug
    const resolved1 = await service.resolve(flagName, {
      projectSlug: "agenthive",
    });
    console.log("Resolved with tenant:", resolved1);

    // Without tenant slug
    service.clearCache();
    const resolved2 = await service.resolve(flagName);
    console.log("Resolved without tenant:", resolved2);
    console.log("Expected enabled=false, got:", resolved2.enabled);
  } finally {
    await pool.query(
      `DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'test.ac10_debug_%'`
    );
    await pool.end();
  }
});
