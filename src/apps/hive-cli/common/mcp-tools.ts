/**
 * Typed MCP Tool Wrappers for hive CLI
 *
 * This module exposes strongly-typed wrappers around the MCP server's
 * consolidated tool surface (mcp_proposal, mcp_message, mcp_agent, etc.).
 *
 * Each wrapper accepts typed arguments and returns typed results, so Round 3
 * implementers don't have to think about the MCP wire format or action names.
 *
 * Action names are discovered at runtime via `action=list_actions` (or hardcoded
 * based on src/apps/mcp-server/tools/consolidated.ts). Callers use these wrappers
 * rather than calling the MCP client directly.
 *
 * @module common/mcp-tools
 */

import type { HiveMcpClient } from "./mcp-client.js";
import type { McpCallOptions } from "./mcp-client.js";

/**
 * Generic handler that delegates a domain action to the MCP server via the client.
 *
 * This is a utility to reduce boilerplate in the tool wrappers below.
 *
 * @private
 */
async function callMcpAction<TArgs extends Record<string, unknown>, TResult>(
  client: HiveMcpClient,
  toolName: string,
  action: string,
  args: TArgs,
  opts?: McpCallOptions
): Promise<TResult> {
  const result = await client.callTool(
    toolName,
    { action, ...args },
    opts
  );

  // Return as-is; the client already parsed JSON content
  return result as TResult;
}

// ============================================================================
// PROPOSAL TOOL WRAPPERS
// ============================================================================

/**
 * Proposal tool wrapper.
 *
 * Wraps the `mcp_proposal` consolidated tool with typed actions.
 * Per contract §6, proposal mutations (claim, transition, maturity, ac add/verify)
 * REQUIRE MCP. Read actions (get, list) MAY fall back to direct DB.
 */
export const proposalTools = {
  /**
   * Get a single proposal by ID.
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID (e.g., "P123")
   * @param opts - Call options (idempotency key, timeout)
   * @returns Proposal object with selected fields
   */
  get: async (
    client: HiveMcpClient,
    proposal_id: string,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_proposal", "get", { proposal_id }, opts);
  },

  /**
   * List proposals with optional filtering.
   *
   * @param client - MCP client
   * @param args - Filter/pagination args (status, project_id, limit, cursor)
   * @param opts - Call options
   * @returns Array of proposals with next_cursor if paginated
   */
  list: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_proposal", "list", args, opts);
  },

  /**
   * Create a new proposal.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Proposal creation args (title, type, description, etc.)
   * @param opts - Call options (idempotency key recommended)
   * @returns Created proposal object with proposal_id
   */
  create: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_proposal", "create", args, opts);
  },

  /**
   * Claim a proposal (acquire a lease).
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - Claim args (duration, agency_id, etc.)
   * @param opts - Call options (idempotency key recommended)
   * @returns Lease object with lease_id, includes idempotent_replay flag
   */
  claim: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "claim",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * Release a proposal lease.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - Release args (lease_id, reason)
   * @param opts - Call options (idempotency key recommended)
   * @returns Success response
   */
  release: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "release",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * Transition a proposal to a new state.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - Transition args (next_state, reason)
   * @param opts - Call options (idempotency key recommended)
   * @returns Updated proposal object with new state
   */
  transition: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "transition",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * Set proposal maturity (new, active, mature, obsolete).
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - Maturity args (maturity)
   * @param opts - Call options (idempotency key recommended)
   * @returns Updated proposal object
   */
  setMaturity: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "set_maturity",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * Add acceptance criteria to a proposal.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - AC args (description, verification_method)
   * @param opts - Call options (idempotency key recommended)
   * @returns Created AC object with ac_id
   */
  addCriteria: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "add_criteria",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * Verify acceptance criteria for a proposal.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param args - Verification args (ac_id, verified, notes)
   * @param opts - Call options (idempotency key recommended)
   * @returns Updated AC object
   */
  verifyCriteria: async (
    client: HiveMcpClient,
    proposal_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "verify_criteria",
      { proposal_id, ...args },
      opts
    );
  },

  /**
   * List acceptance criteria for a proposal.
   *
   * @param client - MCP client
   * @param proposal_id - Proposal ID
   * @param opts - Call options
   * @returns Array of AC objects
   */
  listCriteria: async (
    client: HiveMcpClient,
    proposal_id: string,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_proposal",
      "list_criteria",
      { proposal_id },
      opts
    );
  },
};

// ============================================================================
// MESSAGE TOOL WRAPPERS
// ============================================================================

/**
 * Message tool wrapper.
 *
 * Wraps the `mcp_message` consolidated tool with typed actions.
 * Used for discussions, comments, and async communication within proposals.
 */
export const messageTools = {
  /**
   * Post a message/comment on a proposal.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Message args (proposal_id, body, thread_id)
   * @param opts - Call options (idempotency key recommended)
   * @returns Created message object with message_id
   */
  post: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_message", "post", args, opts);
  },

  /**
   * List messages/discussions for a proposal.
   *
   * @param client - MCP client
   * @param args - Filter args (proposal_id, thread_id, limit)
   * @param opts - Call options
   * @returns Array of message objects
   */
  list: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_message", "list", args, opts);
  },
};

// ============================================================================
// AGENT/WORKER TOOL WRAPPERS
// ============================================================================

/**
 * Agent tool wrapper.
 *
 * Wraps the `mcp_agent` consolidated tool with typed actions.
 * Used for agent/worker lifecycle, leasing, and capacity management.
 */
export const agentTools = {
  /**
   * List active agents.
   *
   * @param client - MCP client
   * @param args - Filter args (status, host, capabilities)
   * @param opts - Call options
   * @returns Array of agent objects
   */
  list: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_agent", "list", args, opts);
  },

  /**
   * Get agent info.
   *
   * @param client - MCP client
   * @param agent_id - Agent ID
   * @param opts - Call options
   * @returns Agent object with full details
   */
  info: async (
    client: HiveMcpClient,
    agent_id: string,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_agent", "info", { agent_id }, opts);
  },

  /**
   * Subscribe an agent to a project.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Subscribe args (agent_id, project_id, capabilities)
   * @param opts - Call options (idempotency key recommended)
   * @returns Updated agent object
   */
  subscribe: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_agent", "subscribe", args, opts);
  },

  /**
   * Suspend an agent.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param agent_id - Agent ID
   * @param args - Suspend args (reason)
   * @param opts - Call options (idempotency key recommended)
   * @returns Updated agent object
   */
  suspend: async (
    client: HiveMcpClient,
    agent_id: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_agent",
      "suspend",
      { agent_id, ...args },
      opts
    );
  },
};

// ============================================================================
// OPS TOOL WRAPPERS
// ============================================================================

/**
 * Ops tool wrapper.
 *
 * Wraps the `mcp_ops` consolidated tool with typed actions.
 * Used for system operations (service control, database maintenance, etc.).
 */
export const opsTools = {
  /**
   * Check system health.
   *
   * @param client - MCP client
   * @param args - Health check args (detailed, checks)
   * @param opts - Call options
   * @returns Health check results
   */
  health: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_ops", "health", args, opts);
  },

  /**
   * Get spending/budget information.
   *
   * @param client - MCP client
   * @param args - Spending args (scope, period)
   * @param opts - Call options
   * @returns Spending/budget object
   */
  spending: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_ops", "spending", args, opts);
  },
};

// ============================================================================
// PROJECT TOOL WRAPPERS
// ============================================================================

/**
 * Project tool wrapper.
 *
 * Wraps the `mcp_project` consolidated tool with typed actions.
 * Used for project CRUD, registration, and configuration.
 */
export const projectTools = {
  /**
   * Get project info.
   *
   * @param client - MCP client
   * @param project_id - Project ID or slug
   * @param opts - Call options
   * @returns Project object with full details
   */
  info: async (
    client: HiveMcpClient,
    project_id: string,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_project", "info", { project_id }, opts);
  },

  /**
   * List projects.
   *
   * @param client - MCP client
   * @param args - Filter args (limit, cursor, status)
   * @param opts - Call options
   * @returns Array of project objects with next_cursor if paginated
   */
  list: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_project", "list", args, opts);
  },

  /**
   * Register/create a new project.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Project creation args (name, repo_url, description)
   * @param opts - Call options (idempotency key recommended)
   * @returns Created project object with project_id
   */
  create: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_project", "create", args, opts);
  },
};

// ============================================================================
// DOCUMENT/KNOWLEDGE TOOL WRAPPERS
// ============================================================================

/**
 * Document tool wrapper.
 *
 * Wraps the `mcp_document` consolidated tool with typed actions.
 * Used for documentation, knowledge base, and decision records.
 */
export const documentTools = {
  /**
   * Get a document by ID.
   *
   * @param client - MCP client
   * @param document_id - Document ID
   * @param opts - Call options
   * @returns Document object with full content
   */
  get: async (
    client: HiveMcpClient,
    document_id: string,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_document", "get", { document_id }, opts);
  },

  /**
   * List documents.
   *
   * @param client - MCP client
   * @param args - Filter args (proposal_id, type, limit, cursor)
   * @param opts - Call options
   * @returns Array of document objects with next_cursor if paginated
   */
  list: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_document", "list", args, opts);
  },

  /**
   * Sync a document (create or update).
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Document args (proposal_id, type, content, title)
   * @param opts - Call options (idempotency key recommended)
   * @returns Synced document object with document_id
   */
  sync: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_document", "sync", args, opts);
  },
};

// ============================================================================
// MEMORY/KNOWLEDGE TOOL WRAPPERS
// ============================================================================

/**
 * Memory tool wrapper.
 *
 * Wraps the `mcp_memory` consolidated tool with typed actions.
 * Used for agent memory, knowledge search, and decision logging.
 */
export const memoryTools = {
  /**
   * Search the knowledge base.
   *
   * @param client - MCP client
   * @param args - Search args (query, scope, limit)
   * @param opts - Call options
   * @returns Array of knowledge base results
   */
  search: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(client, "mcp_memory", "search", args, opts);
  },

  /**
   * Record a decision in the decision log.
   *
   * Mutation; requires MCP (contract §6).
   *
   * @param client - MCP client
   * @param args - Decision args (proposal_id, decision, rationale)
   * @param opts - Call options (idempotency key recommended)
   * @returns Decision log entry with decision_id
   */
  recordDecision: async (
    client: HiveMcpClient,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<Record<string, unknown>> => {
    return callMcpAction(
      client,
      "mcp_memory",
      "record_decision",
      args,
      opts
    );
  },
};

/**
 * Export all tool namespaces for convenient access.
 *
 * Usage:
 * ```ts
 * import { hiveTools } from './mcp-tools.js';
 * const result = await hiveTools.proposal.claim(client, "P123", { ... });
 * ```
 */
export const hiveTools = {
  proposal: proposalTools,
  message: messageTools,
  agent: agentTools,
  ops: opsTools,
  project: projectTools,
  document: documentTools,
  memory: memoryTools,
};
