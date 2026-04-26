import { Pool } from 'pg';
import crypto from 'crypto';

/**
 * P525: Structured Agent Error Catalog with Auto-Recovery
 *
 * All agent errors follow a typed envelope with recovery hints.
 * Errors are logged with auto-deduplication within 60s window.
 */

export interface ErrorEnvelope {
  code: string; // Pattern: AGENTHIVE.<DOMAIN>.<SPECIFIC>
  message: string; // Human-readable summary
  retryable: boolean; // True if operation can be retried
  transient: boolean; // True if error is temporary
  context: Record<string, unknown>; // Domain-specific metadata
  recovery_hint?: string; // Suggested recovery action
  cause_chain?: ErrorEnvelope[]; // Nested error causes
}

export interface ErrorCatalogEntry {
  code: string;
  domain: string;
  severity: string;
  retryable: boolean;
  transient: boolean;
  recovery_strategy: string;
  recovery_hint?: string;
  runbook_url?: string;
}

export interface ErrorLogEntry {
  id: number;
  timestamp: Date;
  code: string;
  agent_identity: string;
  proposal_id?: bigint;
  dispatch_id?: bigint;
  payload: Record<string, unknown>;
  dedup_key: string;
  dedup_count: number;
  resolved_at?: Date;
  recovery_action?: string;
}

/**
 * AgentError: Main error reporting and query interface
 */
export class AgentError {
  constructor(private pool: Pool) {}

  /**
   * Report a structured error to the error catalog and log
   */
  async report(
    envelope: ErrorEnvelope,
    context: {
      agent_identity: string;
      proposal_id?: bigint;
      dispatch_id?: bigint;
    }
  ): Promise<void> {
    // Validate envelope at entry point
    this.validateEnvelope(envelope);

    const dedupKey = this.generateDedupKey(
      envelope.code,
      context.agent_identity,
      context.proposal_id
    );

    try {
      // Check for duplicate within 60s window
      const existing = await this.pool.query(
        `SELECT dedup_count, id FROM roadmap.agent_error_log
         WHERE dedup_key = $1 AND timestamp > now() - interval '60 seconds'
         ORDER BY timestamp DESC LIMIT 1`,
        [dedupKey]
      );

      if (existing.rows.length > 0) {
        // Increment dedup_count instead of creating duplicate
        await this.pool.query(
          `UPDATE roadmap.agent_error_log
           SET dedup_count = dedup_count + 1
           WHERE id = $1`,
          [existing.rows[0].id]
        );
      } else {
        // Create new error log entry
        await this.pool.query(
          `INSERT INTO roadmap.agent_error_log (
            code, agent_identity, proposal_id, dispatch_id,
            payload, dedup_key, dedup_count
          ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [
            envelope.code,
            context.agent_identity,
            context.proposal_id || null,
            context.dispatch_id || null,
            JSON.stringify(envelope),
            dedupKey,
          ]
        );
      }
    } catch (error) {
      // If logging fails, log to console but don't throw
      console.error('[AgentError] Failed to log error:', {
        envelope,
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Validate error envelope conforms to schema
   */
  private validateEnvelope(envelope: ErrorEnvelope): void {
    if (!envelope.code || !/^AGENTHIVE\.[A-Z_]+\.[A-Z_]+$/.test(envelope.code)) {
      throw new Error(
        `Invalid error code format: ${envelope.code}. ` +
          'Must match AGENTHIVE.<DOMAIN>.<SPECIFIC>'
      );
    }

    if (!envelope.message || typeof envelope.message !== 'string') {
      throw new Error('Error envelope must have non-empty message string');
    }

    if (typeof envelope.retryable !== 'boolean') {
      throw new Error('Error envelope must have retryable boolean');
    }

    if (typeof envelope.transient !== 'boolean') {
      throw new Error('Error envelope must have transient boolean');
    }

    if (!envelope.context || typeof envelope.context !== 'object') {
      throw new Error('Error envelope must have context object');
    }
  }

  /**
   * Generate dedup key from code, agent_identity, and proposal_id
   */
  private generateDedupKey(
    code: string,
    agentIdentity: string,
    proposalId?: bigint
  ): string {
    const keyStr = `${code}|${agentIdentity}|${proposalId || ''}`;
    return crypto.createHash('sha256').update(keyStr).digest('hex');
  }

  /**
   * Query recent errors from error log
   */
  async list(params: {
    limit?: number;
    severity?: string;
    agent_identity?: string;
    after_timestamp?: Date;
  }): Promise<ErrorLogEntry[]> {
    const limit = params.limit || 100;
    const afterTs = params.after_timestamp || new Date(Date.now() - 24 * 60 * 60 * 1000);

    let query = `
      SELECT l.id, l.timestamp, l.code, l.agent_identity,
             l.proposal_id, l.dispatch_id, l.payload, l.dedup_key,
             l.dedup_count, l.resolved_at, l.recovery_action
      FROM roadmap.agent_error_log l
      JOIN roadmap.agent_error_catalog c ON l.code = c.code
      WHERE l.timestamp > $1
    `;

    const args: unknown[] = [afterTs];

    if (params.severity) {
      args.push(params.severity);
      query += ` AND c.severity = $${args.length}`;
    }

    if (params.agent_identity) {
      args.push(params.agent_identity);
      query += ` AND l.agent_identity = $${args.length}`;
    }

    query += ` ORDER BY l.timestamp DESC LIMIT $${args.length + 1}`;
    args.push(limit);

    const result = await this.pool.query(query, args);
    return result.rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.timestamp),
      code: row.code,
      agent_identity: row.agent_identity,
      proposal_id: row.proposal_id ? BigInt(row.proposal_id) : undefined,
      dispatch_id: row.dispatch_id ? BigInt(row.dispatch_id) : undefined,
      payload: row.payload,
      dedup_key: row.dedup_key,
      dedup_count: row.dedup_count,
      resolved_at: row.resolved_at ? new Date(row.resolved_at) : undefined,
      recovery_action: row.recovery_action,
    }));
  }

  /**
   * Get error catalog entry (single code or all)
   */
  async catalogGet(code?: string): Promise<ErrorCatalogEntry | ErrorCatalogEntry[]> {
    if (code) {
      const result = await this.pool.query(
        `SELECT code, domain, severity, retryable, transient,
                recovery_strategy, recovery_hint, runbook_url
         FROM roadmap.agent_error_catalog WHERE code = $1`,
        [code]
      );

      if (result.rows.length === 0) {
        throw new Error(`Error code not found: ${code}`);
      }

      return result.rows[0];
    }

    const result = await this.pool.query(
      `SELECT code, domain, severity, retryable, transient,
              recovery_strategy, recovery_hint, runbook_url
       FROM roadmap.agent_error_catalog
       ORDER BY code`
    );

    return result.rows;
  }

  /**
   * Determine recovery action based on error catalog entry
   */
  async getRecoveryStrategy(code: string): Promise<string> {
    const entry = (await this.catalogGet(code)) as ErrorCatalogEntry;
    return entry.recovery_strategy;
  }

  /**
   * Mark error as resolved
   */
  async markResolved(
    logId: number,
    recoveryAction: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE roadmap.agent_error_log
       SET resolved_at = now(), recovery_action = $1
       WHERE id = $2`,
      [recoveryAction, logId]
    );
  }
}

/**
 * Create singleton instance from pool
 */
let agentErrorInstance: AgentError | null = null;

export function initAgentError(pool: Pool): AgentError {
  agentErrorInstance = new AgentError(pool);
  return agentErrorInstance;
}

export function getAgentError(): AgentError {
  if (!agentErrorInstance) {
    throw new Error('AgentError not initialized. Call initAgentError(pool) first.');
  }
  return agentErrorInstance;
}
