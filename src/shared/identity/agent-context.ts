/**
 * P843: AgentContext Carrier
 *
 * AsyncLocalStorage-based carrier for verified principal identity
 * across async call boundaries in the MCP server.
 *
 * This is the single authoritative export of AgentContext and its storage.
 * No other file may create a second AsyncLocalStorage<AgentContext>.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Verified principal information set by authentication gates.
 * Matches the VerifiedPrincipal interface from principal-verifier.ts.
 */
export interface VerifiedPrincipal {
	principal_id: string;
	principal_kind: "operator" | "agency" | "agent";
	parent_principal_id: string | null;
}

/**
 * Container for the verified principal in async context.
 */
export interface AgentContext {
	verified: VerifiedPrincipal;
}

/**
 * AsyncLocalStorage for propagating verified principal through the call stack.
 * Used by:
 *  - HTTP handlers (SSE, direct MCP) to set context for operator bearers
 *  - callTool() to read context set by transport handlers
 *  - Auth decision logging to retrieve current principal_id
 */
export const agentContextStorage = new AsyncLocalStorage<AgentContext>();
