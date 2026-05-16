/**
 * P1103: Schema governance tests
 *
 * AC-1: schema_version column exists with correct type and default
 * AC-2: new INSERTs default schema_version to 1
 * AC-3: message type drift script returns 0 in happy path
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { Pool } from 'pg';
import { MESSAGE_TYPES } from '../../src/infra/messaging/message-types';

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'admin',
  database: process.env.DB_NAME || 'agenthive',
  password: process.env.DB_PASSWORD,
});

describe('P1103: Schema Governance', () => {
  beforeAll(async () => {
    // Ensure connection is alive
    const result = await pool.query('SELECT 1');
    expect(result.rows[0]).toEqual({ '?column?': 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('AC-1: schema_version column', () => {
    it('should exist with type smallint', async () => {
      const result = await pool.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name = 'message_ledger'
          AND column_name = 'schema_version';
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].data_type).toBe('smallint');
    });

    it('should have NOT NULL constraint', async () => {
      const result = await pool.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name = 'message_ledger'
          AND column_name = 'schema_version';
      `);

      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('should default to 1', async () => {
      const result = await pool.query(`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'roadmap'
          AND table_name = 'message_ledger'
          AND column_name = 'schema_version';
      `);

      expect(result.rows[0].column_default).toMatch(/1/);
    });
  });

  describe('AC-2: new inserts', () => {
    it('should default schema_version to 1 on INSERT', async () => {
      const result = await pool.query(`
        INSERT INTO roadmap.message_ledger (
          sender, recipient, channel, message_type, body, metadata
        ) VALUES (
          'test-sender', 'test-recipient', NULL, 'text', '{}', '{}'
        )
        RETURNING id, schema_version;
      `);

      const inserted = result.rows[0];
      expect(inserted.schema_version).toBe(1);

      // Cleanup
      await pool.query('DELETE FROM roadmap.message_ledger WHERE id = $1', [inserted.id]);
    });
  });

  describe('AC-3: message type drift script', () => {
    it('should return 0 when TS enum matches DB constraint', async () => {
      try {
        execSync('node --loader tsx scripts/check-message-type-drift.ts', {
          cwd: process.env.AGENHIVE_ROOT || '/data/code/AgentHive',
          stdio: 'pipe',
        });
        expect(true).toBe(true); // Script exited 0
      } catch (e) {
        const error = e as { stdout?: string; stderr?: string };
        throw new Error(
          `Drift script failed: ${error.stdout || ''} ${error.stderr || ''}`
        );
      }
    });

    it('should have 14 canonical message types', () => {
      expect(MESSAGE_TYPES).toHaveLength(14);
      expect(MESSAGE_TYPES).toContain('text');
      expect(MESSAGE_TYPES).toContain('task');
      expect(MESSAGE_TYPES).toContain('protocol_ping');
      expect(MESSAGE_TYPES).toContain('task_error');
    });
  });
});
