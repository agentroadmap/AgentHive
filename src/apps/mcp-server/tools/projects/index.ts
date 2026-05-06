/**
 * Project Registry & Lifecycle Tools Registration (P482 Phase 1 + P483 Phase 1)
 *
 * Registers `project_set`, `project_registry_list`, and `project_create_v2` handlers.
 *
 * CRITICAL: P297 already uses name "project_create" at server.ts:1350.
 * This module uses "project_create_v2" to avoid collision (MCP name collision is silent last-write-wins).
 */

import type { McpServer } from "../../server.ts";
import type { CallToolResult, McpToolHandler } from "../../types.ts";
import { setProject, listProjects } from "./handlers.ts";
import { projectCreate } from "./lifecycle-handlers.ts";
import {
	listRoutes,
	listCapabilities,
	listCaps,
	addRoute,
	removeRoute,
	setCapabilityScope,
	setBudgetCap,
} from "./allowlist-handlers.ts";

export function registerProjectTools(server: McpServer): void {
	server.addTool({
		name: "project_set",
		description:
			"Set the current project context. Accepts project slug or numeric id. Returns {ok, project, scope}.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description:
						"Project slug (e.g. 'agenthive', 'audiobook') or numeric id (e.g. '1')",
				},
				sessionId: {
					type: "string",
					description:
						"(Optional) SSE session id for per-session binding. If omitted, binding is process-wide.",
				},
			},
			required: ["project"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return setProject({
				project: args.project as string | undefined,
				sessionId: args.sessionId as string | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_registry_list",
		description:
			"List all projects from the multi-project registry (P482). Returns {total, returned, truncated, limit, items[]}. Distinct from P297's project_list which returns a one-line summary.",
		inputSchema: {
			type: "object",
			properties: {
				include_archived: {
					type: "boolean",
					description:
						"Include archived projects in the list. Default: false (active only).",
				},
				limit: {
					type: "number",
					description: "Max results to return. Default: 50. Max: 500.",
				},
			},
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return listProjects({
				include_archived: args.include_archived as boolean | undefined,
				limit: args.limit as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_create_v2",
		description:
			"Create a new project with transactional safety (P483 Phase 1). Validates slug, creates DB registry entry, queues worktree directory creation. Returns {ok, project, worktree_created, repair_needed, note}. Pre-freezes signature for P432 project_attach.",
		inputSchema: {
			type: "object",
			properties: {
				slug: {
					type: "string",
					description:
						"Project slug: lowercase, alphanumeric + hyphens, 3-64 chars. Must match ^[a-z][a-z0-9-]*[a-z0-9]$",
				},
				name: {
					type: "string",
					description: "Project display name (required, non-empty).",
				},
				worktree_root: {
					type: "string",
					description:
						"(Optional) Custom worktree root path. If omitted, defaults to ${AGENTHIVE_WORKTREES_ROOT ?? /data/code}/${slug}/worktree.",
				},
				default_workflow_template: {
					type: "string",
					description:
						"(Optional) Workflow template to clone for new project. Deferred to P483 Phase 2 (requires workflow_templates composite PK).",
				},
			},
			required: ["slug", "name"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return projectCreate({
				slug: args.slug as string | undefined,
				name: args.name as string | undefined,
				worktree_root: args.worktree_root as string | undefined,
				default_workflow_template: args.default_workflow_template as string | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_route_list",
		description:
			"List routes in the allowlist for a project (P484 Phase 1). Returns {total, returned, limit, offset, truncated, items[]}. Read-only; mutations deferred to Phase 2 (P472 authorization).",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				limit: {
					type: "number",
					description: "Max results to return. Default: 50. Max: 500.",
				},
				offset: {
					type: "number",
					description: "Pagination offset. Default: 0.",
				},
			},
			required: ["project_id"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return listRoutes({
				project_id: args.project_id as number,
				limit: args.limit as number | undefined,
				offset: args.offset as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_capability_list",
		description:
			"List capabilities in scope for a project (P484 Phase 1). Returns {total, returned, limit, offset, truncated, items[]}. Read-only; mutations deferred to Phase 2 (P472 authorization).",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				limit: {
					type: "number",
					description: "Max results to return. Default: 50. Max: 500.",
				},
				offset: {
					type: "number",
					description: "Pagination offset. Default: 0.",
				},
			},
			required: ["project_id"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return listCapabilities({
				project_id: args.project_id as number,
				limit: args.limit as number | undefined,
				offset: args.offset as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_cap_list",
		description:
			"List budget caps for a project (P484 Phase 1). Returns {total, returned, limit, offset, truncated, items[]}. Periods are 'day', 'week', 'month'. Read-only; mutations deferred to Phase 2 (P472 authorization).",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				limit: {
					type: "number",
					description: "Max results to return. Default: 50. Max: 500.",
				},
				offset: {
					type: "number",
					description: "Pagination offset. Default: 0.",
				},
			},
			required: ["project_id"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return listCaps({
				project_id: args.project_id as number,
				limit: args.limit as number | undefined,
				offset: args.offset as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_route_add",
		description:
			"Add or update a route in the allowlist for a project (P484 Phase 2). Requires operator or authority trust tier. Returns {ok, route_name, project_id, auth_mode}.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				route_name: {
					type: "string",
					description: "Route name (e.g., 'claude-opus', 'gpt-4'). Case-sensitive.",
				},
				max_calls_per_day: {
					type: "number",
					description: "(Optional) Max calls per day for this route.",
				},
				max_tokens_per_day: {
					type: "number",
					description: "(Optional) Max tokens per day for this route.",
				},
			},
			required: ["project_id", "route_name"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return addRoute({
				project_id: args.project_id as number,
				route_name: args.route_name as string,
				max_calls_per_day: args.max_calls_per_day as number | undefined,
				max_tokens_per_day: args.max_tokens_per_day as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_route_remove",
		description:
			"Remove a route from the allowlist for a project (P484 Phase 2). Requires operator or authority trust tier. Returns {ok, deleted, project_id, route_name, auth_mode}.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				route_name: {
					type: "string",
					description: "Route name to remove.",
				},
			},
			required: ["project_id", "route_name"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return removeRoute({
				project_id: args.project_id as number,
				route_name: args.route_name as string,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_capability_set",
		description:
			"Set or update capability scope for a project (P484 Phase 2). Requires operator or authority trust tier. Returns {ok, capability_name, project_id, auth_mode}.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				capability_name: {
					type: "string",
					description: "Capability name (e.g., 'web_search', 'knowledge_retrieve'). Case-sensitive.",
				},
				max_concurrency: {
					type: "number",
					description: "(Optional) Max concurrent instances of this capability.",
				},
			},
			required: ["project_id", "capability_name"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return setCapabilityScope({
				project_id: args.project_id as number,
				capability_name: args.capability_name as string,
				max_concurrency: args.max_concurrency as number | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_cap_set",
		description:
			"Set or update a budget cap for a project (P484 Phase 2). Requires operator or authority trust tier. Returns {ok, period, max_usd_cents, project_id, auth_mode}.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from project registry.",
				},
				period: {
					type: "string",
					enum: ["day", "week", "month"],
					description: "Budget period: 'day', 'week', or 'month'.",
				},
				max_usd_cents: {
					type: "number",
					description: "Max USD cents allowed for this period (e.g., 5000 for $50).",
				},
			},
			required: ["project_id", "period", "max_usd_cents"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return setBudgetCap({
				project_id: args.project_id as number,
				period: args.period as "day" | "week" | "month",
				max_usd_cents: args.max_usd_cents as number,
			});
		},
	} as McpToolHandler);
}
