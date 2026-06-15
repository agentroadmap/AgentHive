import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * P1114: trust tiers, ordered by authority. Mirrors the enum already stored on
 * agent_registry.trust_tier — P1114 adds the enforcement that was missing.
 */
export type TrustTier =
	| "external_proxy"
	| "blocked"
	| "restricted"
	| "known"
	| "trusted"
	| "authority";

/** Numeric rank for tier comparison (higher = more authority). */
export const TRUST_TIER_RANK: Record<TrustTier, number> = {
	external_proxy: 0,
	blocked: 1,
	restricted: 2,
	known: 3,
	trusted: 4,
	authority: 5,
};

/** P1114: what kind of operation a tool performs, for clearance auditing. */
export type ClearanceScope =
	| "read"
	| "self_write"
	| "peer_write"
	| "gate_action"
	| "admin"
	| "schema_write";

/** P1114: per-tool minimum clearance declaration. */
export interface ToolClearance {
	min_tier: TrustTier;
	scope: ClearanceScope;
}

/** P1114: true when a caller of `callerTier` meets the `minTier` requirement. */
export function isClearanceAllowed(
	callerTier: TrustTier,
	minTier: TrustTier,
): boolean {
	return (TRUST_TIER_RANK[callerTier] ?? 0) >= TRUST_TIER_RANK[minTier];
}

export interface McpToolHandler {
	name: string;
	description: string;
	inputSchema: object;
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
	/**
	 * P1114: minimum trust_tier + scope required to call this tool. A tool with
	 * NO clearance declaration is treated fail-closed as
	 * {min_tier: 'authority', scope: 'admin'} by the enforcement middleware.
	 */
	clearance?: ToolClearance;
}

export interface McpResourceHandler {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	handler: (uri: string) => Promise<ReadResourceResult>;
}

export interface McpPromptHandler {
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
	handler: (args: Record<string, unknown>) => Promise<GetPromptResult>;
}

export type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	Prompt,
	ReadResourceResult,
	Resource,
	Tool,
};
