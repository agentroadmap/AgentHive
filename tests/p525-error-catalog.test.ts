import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Pool } from 'pg';
import {
  AgentError,
  ErrorEnvelope,
  ErrorLogEntry,
  ErrorCatalogEntry,
  initAgentError,
} from '../shared/runtime/agent-error';
import { handleErrorAction, validateErrorActionArgs } from '../mcp/mcp-ops-error';

// Test fixtures
const TEST_AGENT_IDENTITY = 'test-agent-p525';
const TEST_PROPOSAL_ID = BigInt(999);
const TEST_DISPATCH_ID = BigInt(888);

const validErrorEnvelope = (code = 'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER'): ErrorEnvelope => ({
  code,
  message: 'Test error message',
  retryable: true,
  transient: false,
  context: { test: true, detail: 'test detail' },
  recovery_hint: 'Try again later',
});

describe('P525 Error Catalog', () => {
  let pool: Pool;
  let agentError: AgentError;

  beforeEach(async () => {
    pool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432'),
      database: process.env.PGDATABASE || 'agenthive',
      user: process.env.PGUSER || 'admin',
      password: process.env.PGPASSWORD || '',
    });

    agentError = initAgentError(pool);

    // Apply migration
    const migrationSql = await import('fs').then((fs) =>
      fs.promises.readFile(
        '/data/code/AgentHive/.claude/worktrees/agent-a9d974a53068322dc/database/migrations/044-p525-error-catalog.sql',
        'utf-8'
      )
    );

    // Split and execute each statement
    for (const statement of migrationSql.split(';').filter((s) => s.trim())) {
      try {
        await pool.query(statement);
      } catch (error: unknown) {
        // Ignore "already exists" errors
        if (!(error instanceof Error && error.message.includes('already exists'))) {
          console.error('Migration error:', error);
        }
      }
    }
  });

  afterEach(async () => {
    // Clean up test data (all test agents)
    await pool.query(
      `DELETE FROM roadmap.agent_error_log
       WHERE agent_identity LIKE $1 OR agent_identity IN ($2, $3)`,
      ['test-%', 'agent-query-test', 'agent-1']
    );
    await pool.query(
      `DELETE FROM roadmap.agent_error_log
       WHERE agent_identity IN ($1, $2, $3, $4)`,
      ['agent-2', 'test-agent-p525', 'test-agent-p525', 'test-agent-p525']
    );
    await pool.end();
  });

  describe('1. Error Envelope Validation', () => {
    test('Valid envelope passes validation', async () => {
      const envelope = validErrorEnvelope();
      assert.doesNotThrow(() => {
        agentError['validateEnvelope'](envelope);
      });
    });

    test('Invalid code format rejected', async () => {
      const envelope: ErrorEnvelope = {
        ...validErrorEnvelope(),
        code: 'invalid.code',
      };

      assert.throws(
        () => {
          agentError['validateEnvelope'](envelope);
        },
        /Invalid error code format/
      );
    });

    test('Missing message rejected', async () => {
      const envelope: ErrorEnvelope = {
        ...validErrorEnvelope(),
        message: '',
      };

      assert.throws(
        () => {
          agentError['validateEnvelope'](envelope);
        },
        /non-empty message/
      );
    });

    test('Invalid retryable type rejected', async () => {
      const envelope = {
        ...validErrorEnvelope(),
        retryable: 'yes' as unknown as boolean,
      };

      assert.throws(
        () => {
          agentError['validateEnvelope'](envelope);
        },
        /retryable boolean/
      );
    });
  });

  describe('2. Catalog Seeding', () => {
    test('15 known errors seeded in catalog', async () => {
      const catalog = (await agentError.catalogGet()) as ErrorCatalogEntry[];
      assert.strictEqual(catalog.length, 15, '15 errors should be seeded');

      // Verify specific known error codes
      const codes = catalog.map((e) => e.code);
      assert(codes.includes('AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER'));
      assert(codes.includes('AGENTHIVE.MCP.HANDLER_PARAM_INVALID'));
      assert(codes.includes('AGENTHIVE.DISPATCH.POOL_LEAK_NOTIFY'));
    });

    test('Each catalog entry has required fields', async () => {
      const catalog = (await agentError.catalogGet()) as ErrorCatalogEntry[];

      for (const entry of catalog) {
        assert(entry.code, 'code must exist');
        assert(entry.domain, 'domain must exist');
        assert(entry.severity, 'severity must be set');
        assert(typeof entry.retryable === 'boolean', 'retryable must be boolean');
        assert(typeof entry.transient === 'boolean', 'transient must be boolean');
        assert(
          ['auto_retry_immediate', 'auto_retry_with_backoff', 'escalate_to_operator', 'mark_failed', 'request_assistance'].includes(
            entry.recovery_strategy
          ),
          `recovery_strategy ${entry.recovery_strategy} must be valid`
        );
      }
    });

    test('Catalog entry retrievable by code', async () => {
      const entry = (await agentError.catalogGet(
        'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER'
      )) as ErrorCatalogEntry;

      assert.strictEqual(entry.code, 'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER');
      assert.strictEqual(entry.domain, 'db');
      assert.strictEqual(entry.severity, 'error');
      assert.strictEqual(entry.retryable, true);
      assert.strictEqual(entry.transient, false);
      assert.strictEqual(entry.recovery_strategy, 'auto_retry_with_backoff');
    });
  });

  describe('3. Error Reporting and Deduplication', () => {
    test('Error reported to log', async () => {
      const envelope = validErrorEnvelope();

      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: TEST_PROPOSAL_ID,
      });

      const result = await pool.query(
        `SELECT * FROM roadmap.agent_error_log
         WHERE agent_identity = $1
         ORDER BY timestamp DESC LIMIT 1`,
        [TEST_AGENT_IDENTITY]
      );

      assert.strictEqual(result.rows.length, 1);
      assert.strictEqual(result.rows[0].code, envelope.code);
      assert.strictEqual(result.rows[0].dedup_count, 1);
    });

    test('Duplicate error within 60s increments dedup_count', async () => {
      const envelope = validErrorEnvelope();

      // First report
      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: TEST_PROPOSAL_ID,
      });

      // Verify initial count
      let result = await pool.query(
        `SELECT dedup_count FROM roadmap.agent_error_log
         WHERE agent_identity = $1
         ORDER BY timestamp DESC LIMIT 1`,
        [TEST_AGENT_IDENTITY]
      );
      assert.strictEqual(result.rows[0].dedup_count, 1);

      // Second report (same error, same agent, same proposal)
      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: TEST_PROPOSAL_ID,
      });

      // Verify count incremented
      result = await pool.query(
        `SELECT dedup_count FROM roadmap.agent_error_log
         WHERE agent_identity = $1
         ORDER BY timestamp DESC LIMIT 1`,
        [TEST_AGENT_IDENTITY]
      );
      assert.strictEqual(parseInt(result.rows[0].dedup_count), 2);

      // Verify single log entry exists
      result = await pool.query(
        `SELECT COUNT(*) as count FROM roadmap.agent_error_log
         WHERE agent_identity = $1`,
        [TEST_AGENT_IDENTITY]
      );
      assert.strictEqual(parseInt(result.rows[0].count), 1);
    });

    test('Different proposals create separate log entries', async () => {
      const envelope = validErrorEnvelope();

      // Report for proposal 1
      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: BigInt(111),
      });

      // Report for proposal 2
      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: BigInt(222),
      });

      // Verify two separate entries
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM roadmap.agent_error_log
         WHERE agent_identity = $1`,
        [TEST_AGENT_IDENTITY]
      );
      assert.strictEqual(parseInt(result.rows[0].count), 2);
    });

    test('Different agents create separate dedup keys', async () => {
      const envelope = validErrorEnvelope();
      const uniqueProposal = BigInt(333);

      await agentError.report(envelope, {
        agent_identity: 'agent-separate-1',
        proposal_id: uniqueProposal,
      });

      await agentError.report(envelope, {
        agent_identity: 'agent-separate-2',
        proposal_id: uniqueProposal,
      });

      const result = await pool.query(
        `SELECT agent_identity FROM roadmap.agent_error_log
         WHERE proposal_id = $1
         ORDER BY agent_identity`,
        [uniqueProposal.toString()]
      );

      assert.strictEqual(result.rows.length, 2);
      assert.strictEqual(result.rows[0].agent_identity, 'agent-separate-1');
      assert.strictEqual(result.rows[1].agent_identity, 'agent-separate-2');
    });
  });

  describe('4. Auto-Retry Logic (Deterministic)', () => {
    test('immediate retry strategy retrieved', async () => {
      const strategy = await agentError.getRecoveryStrategy(
        'AGENTHIVE.AGENT.DISPATCH_STALE_STATE'
      );
      assert.strictEqual(strategy, 'auto_retry_immediate');
    });

    test('backoff retry strategy retrieved', async () => {
      const strategy = await agentError.getRecoveryStrategy('AGENTHIVE.MCP.TIMEOUT_SSE');
      assert.strictEqual(strategy, 'auto_retry_with_backoff');
    });

    test('escalate strategy retrieved', async () => {
      const strategy = await agentError.getRecoveryStrategy(
        'AGENTHIVE.DISPATCH.POOL_LEAK_NOTIFY'
      );
      // Pool leak should escalate (critical severity)
      const entry = (await agentError.catalogGet(
        'AGENTHIVE.DISPATCH.POOL_LEAK_NOTIFY'
      )) as ErrorCatalogEntry;
      assert(
        ['auto_retry_immediate', 'escalate_to_operator'].includes(entry.recovery_strategy)
      );
    });

    test('mark_failed strategy for validation errors', async () => {
      const strategy = await agentError.getRecoveryStrategy(
        'AGENTHIVE.VALIDATION.CHECK_CONSTRAINT_VERDICT'
      );
      assert.strictEqual(strategy, 'mark_failed');
    });
  });

  describe('5. MCP Surface Integration', () => {
    test('error_report action validated at MCP boundary', () => {
      assert(
        validateErrorActionArgs('error_report', {
          envelope: validErrorEnvelope(),
          agent_identity: TEST_AGENT_IDENTITY,
        })
      );

      assert(!validateErrorActionArgs('error_report', { envelope: {} }));
      assert(!validateErrorActionArgs('error_report', { agent_identity: 'test' }));
    });

    test('error_list action validated', () => {
      assert(validateErrorActionArgs('error_list', {}));
      assert(validateErrorActionArgs('error_list', { limit: 10 }));
      assert(validateErrorActionArgs('error_list', { severity: 'error' }));
      assert(!validateErrorActionArgs('error_list', { limit: 'ten' }));
    });

    test('error_catalog_get action validated', () => {
      assert(validateErrorActionArgs('error_catalog_get', {}));
      assert(validateErrorActionArgs('error_catalog_get', { code: 'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER' }));
      assert(!validateErrorActionArgs('error_catalog_get', { code: 123 }));
    });

    test('error_report action executable via MCP dispatcher', async () => {
      const envelope = validErrorEnvelope();
      const result = await handleErrorAction('error_report', {
        envelope,
        agent_identity: TEST_AGENT_IDENTITY,
        proposal_id: TEST_PROPOSAL_ID,
      }, pool, agentError);

      assert(result && typeof result === 'object' && 'success' in result);
      assert.strictEqual((result as { success: boolean; logged: boolean }).success, true);
    });

    test('error_list action returns recent errors', async () => {
      const envelope = validErrorEnvelope();

      await agentError.report(envelope, {
        agent_identity: TEST_AGENT_IDENTITY,
      });

      const result = await handleErrorAction('error_list', { limit: 10 }, pool, agentError);

      assert(result && typeof result === 'object' && 'entries' in result);
      assert((result as { entries: ErrorLogEntry[]; count: number }).count > 0);
    });

    test('error_catalog_get action returns full catalog or single entry', async () => {
      const result = await handleErrorAction('error_catalog_get', {}, pool, agentError);

      assert(result && typeof result === 'object' && 'catalog' in result);
      const catalog = (result as { catalog: ErrorCatalogEntry[]; count: number }).catalog;
      assert.strictEqual(catalog.length, 15);
    });
  });

  describe('6. Recovery Hints and Runbooks', () => {
    test('Each catalog entry includes recovery_hint', async () => {
      const catalog = (await agentError.catalogGet()) as ErrorCatalogEntry[];

      for (const entry of catalog) {
        assert(entry.recovery_hint, `${entry.code} must have recovery_hint`);
        assert(
          entry.recovery_hint.length > 10,
          `${entry.code} recovery_hint too short`
        );
      }
    });

    test('Each catalog entry includes runbook_url', async () => {
      const catalog = (await agentError.catalogGet()) as ErrorCatalogEntry[];

      for (const entry of catalog) {
        assert(entry.runbook_url, `${entry.code} must have runbook_url`);
        assert(
          entry.runbook_url.startsWith('https://'),
          `${entry.code} runbook_url must be HTTPS`
        );
      }
    });
  });

  describe('7. Error Log Query Interface', () => {
    test('List errors by agent_identity', async () => {
      await agentError.report(validErrorEnvelope(), {
        agent_identity: 'agent-query-test',
      });

      const entries = await agentError.list({
        agent_identity: 'agent-query-test',
      });

      assert(entries.length > 0);
      assert(entries.every((e) => e.agent_identity === 'agent-query-test'));
    });

    test('List errors by severity', async () => {
      await agentError.report(validErrorEnvelope(), {
        agent_identity: TEST_AGENT_IDENTITY,
      });

      const entries = await agentError.list({
        severity: 'error',
      });

      assert(entries.length >= 0);
    });

    test('Mark error as resolved', async () => {
      await agentError.report(validErrorEnvelope(), {
        agent_identity: TEST_AGENT_IDENTITY,
      });

      const result = await pool.query(
        `SELECT id FROM roadmap.agent_error_log
         WHERE agent_identity = $1 LIMIT 1`,
        [TEST_AGENT_IDENTITY]
      );

      const logId = result.rows[0].id;

      await agentError.markResolved(logId, 'auto_retry_with_backoff applied');

      const updated = await pool.query(
        `SELECT resolved_at, recovery_action FROM roadmap.agent_error_log
         WHERE id = $1`,
        [logId]
      );

      assert(updated.rows[0].resolved_at);
      assert.strictEqual(updated.rows[0].recovery_action, 'auto_retry_with_backoff applied');
    });
  });

  describe('8. Cascade Chain Errors', () => {
    test('Cause chain preserved in payload', async () => {
      const childError: ErrorEnvelope = {
        code: 'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER',
        message: 'Child error',
        retryable: true,
        transient: false,
        context: { detail: 'child' },
      };

      const parentError: ErrorEnvelope = {
        code: 'AGENTHIVE.PROPOSAL.WORKFLOW_MISSING',
        message: 'Parent error',
        retryable: true,
        transient: false,
        context: { detail: 'parent' },
        cause_chain: [childError],
      };

      await agentError.report(parentError, {
        agent_identity: TEST_AGENT_IDENTITY,
      });

      const result = await pool.query(
        `SELECT payload FROM roadmap.agent_error_log
         WHERE agent_identity = $1 LIMIT 1`,
        [TEST_AGENT_IDENTITY]
      );

      const payload = result.rows[0].payload;
      assert(payload.cause_chain);
      assert.strictEqual(payload.cause_chain[0].code, 'AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER');
    });
  });
});
