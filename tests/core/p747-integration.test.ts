/**
 * P747 Integration Test
 * Verifies all database schemas exist and can be queried
 */

import { describe, it, expect } from "bun:test";
import { query } from "../../src/infra/postgres/pool.ts";

describe("P747 Infrastructure Tests", () => {
  it("should have created control_model.project_route_policy table", async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='control_model' AND table_name='project_route_policy'`,
    );
    expect(rows.length).toBe(1);
  });

  it("should have created hivecentral.host_model_policy table", async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='hivecentral' AND table_name='host_model_policy'`,
    );
    expect(rows.length).toBe(1);
  });

  it("should have created roadmap_efficiency.route_token_budget table", async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='roadmap_efficiency' AND table_name='route_token_budget'`,
    );
    expect(rows.length).toBe(1);
  });

  it("should have added can_spawn_workers column to model_routes", async () => {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='roadmap' AND table_name='model_routes'
       AND column_name='can_spawn_workers'`,
    );
    expect(rows.length).toBe(1);
  });

  it("should have added fallback_route_id column to model_routes", async () => {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='roadmap' AND table_name='model_routes'
       AND column_name='fallback_route_id'`,
    );
    expect(rows.length).toBe(1);
  });

  it("should have created route_decision_log table", async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='roadmap' AND table_name='route_decision_log'`,
    );
    expect(rows.length).toBe(1);
  });
});
