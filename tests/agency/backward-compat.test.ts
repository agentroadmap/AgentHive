/**
 * AC-5: Backward compatibility — bot host and old agent_runs rows
 *
 * Tests:
 *   - fn_resolve_route_preflight allows empty-allow-list hosts (bot-like policy)
 *   - Old agent_runs rows can be inserted without the new P444 columns (all nullable)
 *   - New columns on agent_runs default to NULL for legacy inserts
 *   - fn_check_spawn_policy still works after column rename (allowed_route_providers)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from './helpers.js';
import type { Pool } from 'pg';

describe('P444: backward compatibility', () => {
  let pool: Pool;
  let legacyRunId: string;

  const BOT_HOST = 'p444_compat_bot_host';
  const MODEL    = 'p444_compat_model/v1';

  before(async () => {
    pool = createPool();

    // Seed a bot-like host: empty allow list, no forbidden providers
    await pool.query(`
      INSERT INTO roadmap.host_model_policy
        (host_name, allowed_route_providers, forbidden_providers, default_model, stale_after_seconds)
      VALUES ($1, ARRAY[]::TEXT[], ARRAY[]::TEXT[], 'none', 3600)
      ON CONFLICT (host_name) DO UPDATE SET
        allowed_route_providers = EXCLUDED.allowed_route_providers,
        forbidden_providers     = EXCLUDED.forbidden_providers,
        updated_at              = now()
    `, [BOT_HOST]);

    // Seed supporting model
    await pool.query(`
      INSERT INTO roadmap.model_metadata (model_name, provider, context_window)
      VALUES ($1, 'p444_compat_prov', 4096)
      ON CONFLICT (model_name) DO NOTHING
    `, [MODEL]);
  });

  after(async () => {
    if (legacyRunId) {
      await pool.query(
        `DELETE FROM roadmap_workforce.agent_runs WHERE id = $1`, [legacyRunId],
      );
    }
    await pool.query(`DELETE FROM roadmap.model_metadata WHERE model_name = $1`, [MODEL]);
    await pool.query(`DELETE FROM roadmap.model_routes   WHERE model_name = $1`, [MODEL]);
    await pool.query(`DELETE FROM roadmap.host_model_policy WHERE host_name = $1`, [BOT_HOST]);
    await pool.end();
  });

  it('fn_resolve_route_preflight allows any route_provider on empty-allow-list host', async () => {
    // Seed a route with any provider
    const { rows: [r] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap.model_routes
        (model_name, route_provider, agent_provider, is_enabled)
      VALUES ($1, 'any_provider', 'p444_compat_agent', true)
      ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET is_enabled = true
      RETURNING id
    `, [MODEL]);

    const { rows } = await pool.query<{ allowed: boolean; reason: string | null }>(
      `SELECT allowed, reason FROM roadmap.fn_resolve_route_preflight($1, $2, $3)`,
      [BOT_HOST, r.id, 'p444_compat_agent'],
    );
    assert.equal(rows[0]?.allowed, true,
      `empty-allow-list host must allow any provider; reason: ${rows[0]?.reason}`);
    assert.equal(rows[0]?.reason, null);
  });

  it('fn_check_spawn_policy still works after allowed_providers→allowed_route_providers rename', async () => {
    // Empty allow list → any non-forbidden route is allowed
    const { rows } = await pool.query<{ fn_check_spawn_policy: boolean }>(
      `SELECT roadmap.fn_check_spawn_policy($1, 'any_provider') AS fn_check_spawn_policy`,
      [BOT_HOST],
    );
    assert.equal(rows[0]?.fn_check_spawn_policy, true,
      'fn_check_spawn_policy must return true for empty-allow-list host');
  });

  it('agent_runs INSERT succeeds without P444 columns (all nullable)', async () => {
    // Insert a legacy-style run: only the columns that existed before P444
    const { rows: [row] } = await pool.query<{ id: string }>(`
      INSERT INTO roadmap_workforce.agent_runs
        (agent_identity, stage, model_used, status)
      VALUES ('p444-compat-agent@test', 'Develop', 'legacy-model', 'running')
      RETURNING id
    `);
    assert.ok(row?.id, 'INSERT must return an id');
    legacyRunId = row.id;
  });

  it('new P444 columns default to NULL for legacy rows', async () => {
    assert.ok(legacyRunId, 'depends on previous test inserting legacyRunId');
    const { rows: [run] } = await pool.query(`
      SELECT dispatch_id, agency_id, worker_id, host_id,
             provider_account_id, route_id, agent_cli,
             agent_provider, route_provider, auth_source_class, worktree_id
      FROM roadmap_workforce.agent_runs
      WHERE id = $1
    `, [legacyRunId]);

    for (const col of [
      'dispatch_id', 'agency_id', 'worker_id', 'host_id',
      'provider_account_id', 'route_id', 'agent_cli',
      'agent_provider', 'route_provider', 'auth_source_class', 'worktree_id',
    ]) {
      assert.equal(
        run[col], null,
        `column ${col} must be NULL for legacy row; got ${JSON.stringify(run[col])}`,
      );
    }
  });

  it('host_model_policy.allowed_route_providers column exists (renamed from allowed_providers)', async () => {
    const { rows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap'
        AND table_name   = 'host_model_policy'
        AND column_name  = 'allowed_route_providers'
    `);
    assert.equal(rows.length, 1,
      'allowed_route_providers column must exist on host_model_policy');
  });

  it('old allowed_providers column no longer exists', async () => {
    const { rows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap'
        AND table_name   = 'host_model_policy'
        AND column_name  = 'allowed_providers'
    `);
    assert.equal(rows.length, 0,
      'old allowed_providers column must not exist after P444 migration');
  });
});
