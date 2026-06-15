/**
 * P1376-AC3/AC6: Tests for GREATEST() merge between proactive and reactive cooldowns.
 *
 * AC-3: Unit tests for GREATEST merge semantics.
 * AC-4: Idempotent write pattern verification.
 * AC-6: End-to-end scenario test with both proactive and reactive throttles.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { query as _pgQuery } from "../../../infra/postgres/pool.ts";
import { checkMergedThrottle } from "../resolvers/throttle-filter.ts";

// Test database connection
const query = _pgQuery;

/**
 * AC-3: Test GREATEST merge semantics: proactive-only, reactive-only, both, neither.
 */
describe("P1376 GREATEST Throttle Merge", () => {
  const testProvider = "test-p1376";
  const testModel = "test-model";
  const testAgencyId = "test-agency-1376";

  beforeEach(async () => {
    // Clean up test data before each test
    await query(
      `DELETE FROM roadmap_workforce.agency_capacity
       WHERE provider = $1 AND model = $2 AND agency_id = $3`,
      [testProvider, testModel, testAgencyId]
    );
    await query(
      `DELETE FROM roadmap.model_routes
       WHERE route_provider = $1 AND model_name = $2`,
      [testProvider, testModel]
    );
    await query(
      `DELETE FROM roadmap.model_metadata
       WHERE provider = $1 AND model_name = $2`,
      [testProvider, testModel]
    );

    // Insert test model_metadata to satisfy FK constraint
    await query(
      `INSERT INTO roadmap.model_metadata (provider, model_name)
       VALUES ($1, $2)
       ON CONFLICT (provider, model_name) DO NOTHING`,
      [testProvider, testModel]
    );
  });

  it("AC-3a: Proactive throttle only (no reactive) returns proactive window", async () => {
    const resetAt = new Date(Date.now() + 5 * 60 * 1000); // +5 min

    // Insert proactive throttle only
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testProvider, testModel, testAgencyId, resetAt, "hard", 0]
    );

    // No reactive throttle (cooldown_until IS NULL in model_routes)

    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, true);
    assert.strictEqual(status.throttleSource, "proactive");
    assert(
      status.computedThrottleUntil !== null &&
        Math.abs(
          status.computedThrottleUntil.getTime() - resetAt.getTime()
        ) < 1000
    );
  });

  it("AC-3b: Reactive throttle only (no proactive) returns reactive window", async () => {
    // Insert reactive throttle only (no agency_capacity row)
    const cooldownUntil = new Date(Date.now() + 2 * 60 * 1000); // +2 min

    await query(
      `INSERT INTO roadmap.model_routes
       (route_provider, model_name, agent_provider, agent_cli, cooldown_until, is_enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE
       SET cooldown_until = EXCLUDED.cooldown_until`,
      [testProvider, testModel, testProvider, testAgencyId, cooldownUntil]
    );

    // No proactive throttle
    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, true);
    assert.strictEqual(status.throttleSource, "reactive");
  });

  it("AC-3c: Both throttles present returns GREATEST (longer window)", async () => {
    const proactiveReset = new Date(Date.now() + 5 * 60 * 1000); // +5 min (proactive longer)
    const reactiveUntil = new Date(Date.now() + 2 * 60 * 1000); // +2 min

    // Insert proactive
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testProvider, testModel, testAgencyId, proactiveReset, "hard", 0]
    );

    // Insert reactive
    await query(
      `INSERT INTO roadmap.model_routes
       (route_provider, model_name, agent_provider, agent_cli, cooldown_until, is_enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE
       SET cooldown_until = EXCLUDED.cooldown_until`,
      [testProvider, testModel, testProvider, testAgencyId, reactiveUntil]
    );

    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, true);
    assert.strictEqual(status.throttleSource, "proactive");
    assert(
      status.computedThrottleUntil !== null &&
        Math.abs(
          status.computedThrottleUntil.getTime() - proactiveReset.getTime()
        ) < 1000,
      "GREATEST should return the longer window (proactive)"
    );
  });

  it("AC-3d: Both throttles present (reactive longer) returns GREATEST", async () => {
    const proactiveReset = new Date(Date.now() + 2 * 60 * 1000); // +2 min (reactive longer)
    const reactiveUntil = new Date(Date.now() + 5 * 60 * 1000); // +5 min

    // Insert proactive
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testProvider, testModel, testAgencyId, proactiveReset, "hard", 0]
    );

    // Insert reactive
    await query(
      `INSERT INTO roadmap.model_routes
       (route_provider, model_name, agent_provider, agent_cli, cooldown_until, is_enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE
       SET cooldown_until = EXCLUDED.cooldown_until`,
      [testProvider, testModel, testProvider, testAgencyId, reactiveUntil]
    );

    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, true);
    assert.strictEqual(status.throttleSource, "reactive");
    assert(
      status.computedThrottleUntil !== null &&
        Math.abs(
          status.computedThrottleUntil.getTime() - reactiveUntil.getTime()
        ) < 1000,
      "GREATEST should return the longer window (reactive)"
    );
  });

  it("AC-3e: Neither throttle returns healthy (not throttled)", async () => {
    // No proactive, no reactive

    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, false);
    assert.strictEqual(status.throttleSource, "none");
  });

  it("AC-4: Idempotent write pattern preserves longer cooldown", async () => {
    const initialWindow = new Date(Date.now() + 5 * 60 * 1000);
    const laterWindow = new Date(Date.now() + 10 * 60 * 1000);

    // First write: set to 5 min
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, model, agency_id) DO UPDATE
       SET reset_at = GREATEST(COALESCE(EXCLUDED.reset_at, 'epoch'::timestamptz), COALESCE(roadmap_workforce.agency_capacity.reset_at, 'epoch'::timestamptz))`,
      [testProvider, testModel, testAgencyId, initialWindow, "hard", 0]
    );

    let status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );
    assert.strictEqual(status.isThrottled, true);
    const firstWindow = status.computedThrottleUntil;

    // Second write: attempt to set to 10 min (should win since it's later)
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, model, agency_id) DO UPDATE
       SET reset_at = GREATEST(COALESCE(EXCLUDED.reset_at, 'epoch'::timestamptz), COALESCE(roadmap_workforce.agency_capacity.reset_at, 'epoch'::timestamptz))`,
      [testProvider, testModel, testAgencyId, laterWindow, "hard", 0]
    );

    status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );
    assert.strictEqual(status.isThrottled, true);
    const secondWindow = status.computedThrottleUntil;

    assert(
      secondWindow !== null && firstWindow !== null,
      "Windows should not be null"
    );
    assert(
      secondWindow.getTime() >= firstWindow.getTime(),
      "Second window should be >= first (GREATEST)"
    );
  });

  it("AC-6: E2E scenario — proactive hard throttle + reactive 429 respects GREATEST", async () => {
    // Scenario: agency hits hard throttle at 5 min; simultaneously receives 429 at 2 min
    const proactiveHardUntil = new Date(Date.now() + 5 * 60 * 1000);
    const reactiveUntil = new Date(Date.now() + 2 * 60 * 1000);

    // Step 1: Proactive monitoring sets hard throttle
    await query(
      `INSERT INTO roadmap_workforce.agency_capacity
       (provider, model, agency_id, reset_at, throttle_action, p_skip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testProvider, testModel, testAgencyId, proactiveHardUntil, "hard", 0]
    );

    // Step 2: Reactive handler tries to set cooldown from 429 (should preserve proactive)
    await query(
      `INSERT INTO roadmap.model_routes
       (route_provider, model_name, agent_provider, agent_cli, cooldown_until, is_enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE
       SET cooldown_until = GREATEST(
         COALESCE(EXCLUDED.cooldown_until, 'epoch'::timestamptz),
         COALESCE(roadmap.model_routes.cooldown_until, 'epoch'::timestamptz)
       )`,
      [testProvider, testModel, testProvider, testAgencyId, reactiveUntil]
    );

    // Step 3: Verify resolver sees the 5-min hold, not 2-min
    const status = await checkMergedThrottle(
      testProvider,
      testModel,
      testAgencyId
    );

    assert.strictEqual(status.isThrottled, true);
    assert.strictEqual(status.throttleSource, "proactive");
    assert(
      status.computedThrottleUntil !== null &&
        Math.abs(
          status.computedThrottleUntil.getTime() - proactiveHardUntil.getTime()
        ) < 1000,
      "Resolver should respect proactive hard throttle (5 min), not reactive 429 (2 min)"
    );
  });
});
