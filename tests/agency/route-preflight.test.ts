/**
 * AC-4: fn_resolve_route_preflight pre-flight gate
 *
 * Tests:
 *   - Unknown route_id → ROUTE_NOT_FOUND
 *   - Disabled route → ROUTE_DISABLED
 *   - agent_provider mismatch → AGENT_PROVIDER_MISMATCH
 *   - Route provider in forbidden_providers → POLICY_FORBIDDEN
 *   - Route provider not in non-empty allowed_route_providers → POLICY_NOT_ALLOWED
 *   - Stale route (last_validated_at too old) → ROUTE_STALE
 *   - NULL last_validated_at → allowed (treated as fresh)
 *   - Unknown host (not in host_model_policy) → allowed (legacy permit)
 *   - Happy path — all checks pass → allowed=true, reason=null
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from './helpers.js';
import type { Pool } from 'pg';

const TEST_HOST = 'p444_test_host';
const MODEL = 'p444_test_model/v1';

describe('P444: fn_resolve_route_preflight', () => {
  let pool: Pool;
  let routeId: bigint;
  let disabledRouteId: bigint;

  before(async () => {
    pool = createPool();

    // Ensure test model exists in model_metadata
    await pool.query(`
      INSERT INTO roadmap.model_metadata (model_name, provider, context_window)
      VALUES ($1, 'p444_test_provider', 8192)
      ON CONFLICT (model_name) DO NOTHING
    `, [MODEL]);

    // Seed a test host policy
    await pool.query(`
      INSERT INTO roadmap.host_model_policy
        (host_name, allowed_route_providers, forbidden_providers, default_model, stale_after_seconds)
      VALUES ($1, ARRAY['p444_ok'], ARRAY['p444_forbidden'], 'none', 60)
      ON CONFLICT (host_name) DO UPDATE SET
        allowed_route_providers = EXCLUDED.allowed_route_providers,
        forbidden_providers     = EXCLUDED.forbidden_providers,
        stale_after_seconds     = EXCLUDED.stale_after_seconds,
        updated_at              = now()
    `, [TEST_HOST]);

    // Seed active test route
    const { rows: [r] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap.model_routes
        (model_name, route_provider, agent_provider, is_enabled, last_validated_at)
      VALUES ($1, 'p444_ok', 'p444_agent', true, now())
      ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET
        is_enabled       = true,
        last_validated_at = now()
      RETURNING id
    `, [MODEL]);
    routeId = BigInt(r.id);

    // Seed disabled route
    const { rows: [d] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap.model_routes
        (model_name, route_provider, agent_provider, is_enabled)
      VALUES ($1, 'p444_disabled_prov', 'p444_agent', false)
      ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET
        is_enabled = false
      RETURNING id
    `, [MODEL]);
    disabledRouteId = BigInt(d.id);
  });

  after(async () => {
    await pool.query(
      `DELETE FROM roadmap.model_routes WHERE model_name = $1`, [MODEL],
    );
    await pool.query(
      `DELETE FROM roadmap.model_metadata WHERE model_name = $1`, [MODEL],
    );
    await pool.query(
      `DELETE FROM roadmap.host_model_policy WHERE host_name = $1`, [TEST_HOST],
    );
    await pool.end();
  });

  async function preflight(host: string, rid: bigint | number, agentProv: string) {
    const { rows } = await pool.query<{ allowed: boolean; reason: string | null }>(
      `SELECT allowed, reason FROM roadmap.fn_resolve_route_preflight($1, $2, $3)`,
      [host, rid.toString(), agentProv],
    );
    return rows[0] ?? { allowed: true, reason: null };
  }

  it('ROUTE_NOT_FOUND for non-existent route_id', async () => {
    const result = await preflight(TEST_HOST, 999999999, 'p444_agent');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'ROUTE_NOT_FOUND');
  });

  it('ROUTE_DISABLED for disabled route', async () => {
    const result = await preflight(TEST_HOST, disabledRouteId, 'p444_agent');
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'ROUTE_DISABLED');
  });

  it('AGENT_PROVIDER_MISMATCH when caller sends wrong agent_provider', async () => {
    const result = await preflight(TEST_HOST, routeId, 'wrong_agent');
    assert.equal(result.allowed, false);
    assert.ok(
      result.reason?.startsWith('AGENT_PROVIDER_MISMATCH'),
      `expected AGENT_PROVIDER_MISMATCH; got: ${result.reason}`,
    );
  });

  it('POLICY_FORBIDDEN when route_provider is in forbidden_providers', async () => {
    // Insert a route with a forbidden provider
    const { rows: [f] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap.model_routes
        (model_name, route_provider, agent_provider, is_enabled)
      VALUES ($1, 'p444_forbidden', 'p444_agent', true)
      ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET is_enabled = true
      RETURNING id
    `, [MODEL]);
    const forbiddenId = BigInt(f.id);
    const result = await preflight(TEST_HOST, forbiddenId, 'p444_agent');
    assert.equal(result.allowed, false);
    assert.ok(
      result.reason?.startsWith('POLICY_FORBIDDEN'),
      `expected POLICY_FORBIDDEN; got: ${result.reason}`,
    );
    // cleanup
    await pool.query(`DELETE FROM roadmap.model_routes WHERE id = $1`, [forbiddenId.toString()]);
  });

  it('POLICY_NOT_ALLOWED when route_provider not in non-empty allow list', async () => {
    // Insert a route with a provider that is neither allowed nor forbidden
    const { rows: [u] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap.model_routes
        (model_name, route_provider, agent_provider, is_enabled)
      VALUES ($1, 'p444_unlisted', 'p444_agent', true)
      ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET is_enabled = true
      RETURNING id
    `, [MODEL]);
    const unlistedId = BigInt(u.id);
    const result = await preflight(TEST_HOST, unlistedId, 'p444_agent');
    assert.equal(result.allowed, false);
    assert.ok(
      result.reason?.startsWith('POLICY_NOT_ALLOWED'),
      `expected POLICY_NOT_ALLOWED; got: ${result.reason}`,
    );
    await pool.query(`DELETE FROM roadmap.model_routes WHERE id = $1`, [unlistedId.toString()]);
  });

  it('ROUTE_STALE when last_validated_at exceeds stale_after_seconds', async () => {
    // Temporarily backdate last_validated_at to 2 hours ago
    await pool.query(
      `UPDATE roadmap.model_routes SET last_validated_at = now() - interval '2 hours'
       WHERE id = $1`,
      [routeId.toString()],
    );
    const result = await preflight(TEST_HOST, routeId, 'p444_agent');
    assert.equal(result.allowed, false);
    assert.ok(
      result.reason?.startsWith('ROUTE_STALE'),
      `expected ROUTE_STALE; got: ${result.reason}`,
    );
    // Restore
    await pool.query(
      `UPDATE roadmap.model_routes SET last_validated_at = now() WHERE id = $1`,
      [routeId.toString()],
    );
  });

  it('NULL last_validated_at is treated as fresh (allowed)', async () => {
    await pool.query(
      `UPDATE roadmap.model_routes SET last_validated_at = NULL WHERE id = $1`,
      [routeId.toString()],
    );
    const result = await preflight(TEST_HOST, routeId, 'p444_agent');
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
    // Restore
    await pool.query(
      `UPDATE roadmap.model_routes SET last_validated_at = now() WHERE id = $1`,
      [routeId.toString()],
    );
  });

  it('unknown host is legacy-permitted (allowed=true)', async () => {
    const result = await preflight('p444_nonexistent_host_xyz', routeId, 'p444_agent');
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });

  it('happy path: all checks pass → allowed=true, reason=null', async () => {
    await pool.query(
      `UPDATE roadmap.model_routes SET last_validated_at = now() WHERE id = $1`,
      [routeId.toString()],
    );
    const result = await preflight(TEST_HOST, routeId, 'p444_agent');
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });
});
