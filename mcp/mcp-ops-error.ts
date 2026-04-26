/**
 * P525: MCP Integration for Error Catalog and Auto-Recovery
 *
 * Extends mcp_ops with three new actions:
 * - error_report: Log structured error from subagent
 * - error_list: Query recent errors
 * - error_catalog_get: Fetch error catalog or single entry
 */

import { Pool } from 'pg';
import {
  AgentError,
  ErrorEnvelope,
  ErrorLogEntry,
  ErrorCatalogEntry,
} from '../shared/runtime/agent-error';

export interface ErrorReportAction {
  action: 'error_report';
  args: {
    envelope: ErrorEnvelope;
    agent_identity: string;
    proposal_id?: bigint;
    dispatch_id?: bigint;
  };
}

export interface ErrorListAction {
  action: 'error_list';
  args: {
    limit?: number;
    severity?: string;
    agent_identity?: string;
    after_timestamp?: string; // ISO string
  };
}

export interface ErrorCatalogGetAction {
  action: 'error_catalog_get';
  args: {
    code?: string;
  };
}

export type ErrorMcpAction = ErrorReportAction | ErrorListAction | ErrorCatalogGetAction;

/**
 * Handle error-related MCP actions
 * Integrate with mcp_ops dispatcher
 */
export async function handleErrorAction(
  action: string,
  args: Record<string, unknown>,
  pool: Pool,
  agentError: AgentError
): Promise<unknown> {
  switch (action) {
    case 'error_report': {
      const envelope = args.envelope as ErrorEnvelope;
      const agentIdentity = args.agent_identity as string;
      const proposalId = args.proposal_id as bigint | undefined;
      const dispatchId = args.dispatch_id as bigint | undefined;

      await agentError.report(envelope, {
        agent_identity: agentIdentity,
        proposal_id: proposalId,
        dispatch_id: dispatchId,
      });

      return { success: true, logged: true };
    }

    case 'error_list': {
      const limit = args.limit as number | undefined;
      const severity = args.severity as string | undefined;
      const agentIdentity = args.agent_identity as string | undefined;
      const afterTimestampStr = args.after_timestamp as string | undefined;

      const afterTimestamp = afterTimestampStr ? new Date(afterTimestampStr) : undefined;

      const entries = await agentError.list({
        limit,
        severity,
        agent_identity: agentIdentity,
        after_timestamp: afterTimestamp,
      });

      return { entries, count: entries.length };
    }

    case 'error_catalog_get': {
      const code = args.code as string | undefined;
      const result = await agentError.catalogGet(code);

      if (Array.isArray(result)) {
        return { catalog: result, count: result.length };
      } else {
        return { entry: result };
      }
    }

    default:
      throw new Error(`Unknown error action: ${action}`);
  }
}

/**
 * Validate error action args at MCP boundary
 */
export function validateErrorActionArgs(action: string, args: unknown): boolean {
  if (!args || typeof args !== 'object') {
    return false;
  }

  const obj = args as Record<string, unknown>;

  switch (action) {
    case 'error_report': {
      if (!obj.envelope || typeof obj.envelope !== 'object') return false;
      if (!obj.agent_identity || typeof obj.agent_identity !== 'string') return false;
      return true;
    }

    case 'error_list': {
      if (obj.limit && typeof obj.limit !== 'number') return false;
      if (obj.severity && typeof obj.severity !== 'string') return false;
      if (obj.agent_identity && typeof obj.agent_identity !== 'string') return false;
      if (obj.after_timestamp && typeof obj.after_timestamp !== 'string') return false;
      return true;
    }

    case 'error_catalog_get': {
      if (obj.code && typeof obj.code !== 'string') return false;
      return true;
    }

    default:
      return false;
  }
}
