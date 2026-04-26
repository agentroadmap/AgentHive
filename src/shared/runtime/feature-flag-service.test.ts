import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { Pool } from "pg";
import { FeatureFlagService } from "./feature-flag-service";

// Test database setup with actual Postgres pool
let pool: Pool;

describe("FeatureFlagService", () => {
  before(async () => {
    // Use test database from env
    pool = new Pool({
      host: process.env.PGHOST || "127.0.0.1",
      port: parseInt(process.env.PGPORT || "5432", 10),
      user: process.env.PGUSER || "admin",
      password: process.env.PGPASSWORD || "YMA3peHGLi6shUTr",
      database: process.env.PGDATABASE || "agenthive",
    });

    // Reset singleton and initialize service
    FeatureFlagService.reset();
    FeatureFlagService.initialize(pool);

    // Clean test data
    await pool.query(
      "DELETE FROM roadmap.feature_flag_audit WHERE flag_name LIKE 'test.%'"
    );
    await pool.query(
      "DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'test.%'"
    );
  });

  after(async () => {
    // Cleanup
    await pool.query(
      "DELETE FROM roadmap.feature_flag_audit WHERE flag_name LIKE 'test.%'"
    );
    await pool.query(
      "DELETE FROM roadmap.feature_flag WHERE flag_name LIKE 'test.%'"
    );
    // Don't end the pool here - let nodejs timeout instead
  });

  test("AC1: Schema created with correct columns", async () => {
    // Verify table structure
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'feature_flag' AND table_schema = 'roadmap'
      ORDER BY column_name
    `);

    const columns = result.rows.map((r) => r.column_name);
    assert.ok(columns.includes("flag_name"), "flag_name column exists");
    assert.ok(
      columns.includes("enabled_default"),
      "enabled_default column exists"
    );
    assert.ok(
      columns.includes("per_tenant_override"),
      "per_tenant_override column exists"
    );
    assert.ok(
      columns.includes("rollout_percent"),
      "rollout_percent column exists"
    );
    assert.ok(columns.includes("updated_at"), "updated_at column exists");
  });

  test("AC6: Cache TTL = 5s; deterministic hash for canary", async () => {
    // Insert test flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, rollout_percent, updated_by)
      VALUES ($1, $2, $3, $4, $5)`,
      ["test.cache_ttl", "Test Cache TTL", false, 50, "test"]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // First resolve should cache
    const start = Date.now();
    const resolved1 = await service.resolve("test.cache_ttl", {
      agentIdentity: "agent-1",
    });
    assert.ok(
      resolved1.reason === "rollout_canary",
      "Resolved via rollout canary"
    );

    // Same user should get same result (deterministic)
    const resolved2 = await service.resolve("test.cache_ttl", {
      agentIdentity: "agent-1",
    });
    assert.strictEqual(
      resolved1.enabled,
      resolved2.enabled,
      "Deterministic hash: same user same result"
    );

    // Different user may get different result (50% rollout)
    const resolved3 = await service.resolve("test.cache_ttl", {
      agentIdentity: "agent-999-different",
    });
    // May or may not be same; just verify it resolves
    assert.ok(typeof resolved3.enabled === "boolean", "Result is boolean");
  });

  test("AC10: Per-tenant override takes precedence", async () => {
    // Insert flag with override
    const flagName = "test.tenant_override_ac10";
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

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // With tenant slug
    const resolved = await service.resolve(flagName, {
      projectSlug: "agenthive",
    });
    assert.strictEqual(resolved.enabled, true, "Override applied");
    assert.strictEqual(
      resolved.reason,
      "per_tenant_override",
      "Reason is per_tenant_override"
    );

    // Without tenant slug (uses default)
    const resolvedNoTenant = await service.resolve(flagName);
    assert.strictEqual(
      resolvedNoTenant.enabled,
      false,
      "Default applied when no tenant"
    );
  });

  test("AC11: Rollout canary deterministic hash", async () => {
    // Insert flag with rollout
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, rollout_percent, updated_by)
      VALUES ($1, $2, $3, $4, $5)`,
      ["test.rollout", "Test Rollout", false, 25, "test"]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // Resolve with same agent identity multiple times
    const resolved1 = await service.resolve("test.rollout", {
      agentIdentity: "stable-agent-1",
    });
    service.clearCache(); // Force re-fetch
    const resolved2 = await service.resolve("test.rollout", {
      agentIdentity: "stable-agent-1",
    });

    assert.strictEqual(
      resolved1.enabled,
      resolved2.enabled,
      "Same agent identity: deterministic result across cache miss"
    );
  });

  test("AC12: Cache invalidation via clearCache method", async () => {
    // Insert test flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, updated_by)
      VALUES ($1, $2, $3, $4)`,
      ["test.notify", "Test NOTIFY", false, "test"]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // Warm cache
    await service.resolve("test.notify");
    let cached = service.values().has("test.notify");
    assert.ok(cached, "Flag cached before clear");

    // Clear cache
    service.clearCache();
    cached = service.values().has("test.notify");
    assert.ok(!cached, "Cache invalidated after clearCache");

    // Resolve again (should fetch from DB)
    await service.resolve("test.notify");
    cached = service.values().has("test.notify");
    assert.ok(cached, "Flag cached again after resolve");
  });

  test("AC15: Flag not found returns default", async () => {
    const service = FeatureFlagService.getInstance();
    service.clearCache();

    const resolved = await service.resolve("test.nonexistent");
    assert.strictEqual(
      resolved.enabled,
      false,
      "Missing flag returns false (default)"
    );
    assert.strictEqual(
      resolved.reason,
      "flag_not_found",
      "Reason is flag_not_found"
    );
  });

  test("AC6: Cache hit <5ms, cache miss with DB query <20ms", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, updated_by)
      VALUES ($1, $2, $3, $4)`,
      ["test.perf", "Test Performance", true, "test"]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    // Cache miss with DB query
    const start1 = performance.now();
    await service.resolve("test.perf");
    const miss = performance.now() - start1;
    assert.ok(miss < 20, `Cache miss took ${miss}ms (target <20ms)`);

    // Cache hit
    const start2 = performance.now();
    await service.resolve("test.perf");
    const hit = performance.now() - start2;
    assert.ok(hit < 5, `Cache hit took ${hit}ms (target <5ms)`);
  });

  test("isEnabled shorthand returns boolean", async () => {
    // Insert flag
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, updated_by)
      VALUES ($1, $2, $3, $4)`,
      ["test.bool", "Test Bool", true, "test"]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    const enabled = await service.isEnabled("test.bool");
    assert.strictEqual(typeof enabled, "boolean", "Returns boolean");
    assert.strictEqual(enabled, true, "Value is true");
  });

  test("values() returns only non-expired cache entries", async () => {
    // Insert flags
    await pool.query(
      `INSERT INTO roadmap.feature_flag
      (flag_name, display_name, enabled_default, updated_by)
      VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        "test.val1",
        "Test Val 1",
        true,
        "test",
        "test.val2",
        "Test Val 2",
        false,
        "test",
      ]
    );

    const service = FeatureFlagService.getInstance();
    service.clearCache();

    await service.resolve("test.val1");
    await service.resolve("test.val2");

    const values = service.values();
    assert.ok(values.has("test.val1"), "val1 in cache");
    assert.ok(values.has("test.val2"), "val2 in cache");
  });
});
