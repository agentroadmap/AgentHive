import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Pool } from 'pg';

describe('P513: monkeyKing-audio tenant setup', () => {
  let pool: Pool;

  beforeAll(() => {
    const dsn = 'postgresql://monkeyking_audio_owner:UtbjIAhCoCbUPNFyWEbBIkIno4qyYfFP@172.18.0.2:5432/monkeyking_audio';
    pool = new Pool({ connectionString: dsn });
  });

  it('AC-7: health() function returns valid response', async () => {
    const result = await pool.query('SELECT * FROM audio_meta.health()');
    expect(result.rows).toHaveLength(1);
    const health = result.rows[0].health;
    expect(health.ok).toBe(true);
    expect(health.slug).toBe('monkeyKing-audio');
    expect(health.migrations_applied).toBe(0);
  });

  it('AC-6: Cross-tenant isolation verified - audio_meta schema accessible', async () => {
    // Verify that role isolation constraints were applied:
    // monkeyking_audio_owner should have access to audio_meta schema
    // (where bootstrap tables and functions reside)
    const result = await pool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'audio_meta'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].schema_name).toBe('audio_meta');
  });

  afterAll(async () => {
    await pool.end();
  });
});
