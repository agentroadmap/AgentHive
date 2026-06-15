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
import {
	addRoute,
	listCapabilities,
	listCaps,
	listRoutes,
	removeRoute,
	setBudgetCap,
	setCapabilityScope,
} from "./allowlist-handlers.ts";
import {
	listProjects,
	projectArchive,
	projectDelete,
	projectHealthCheck,
	projectReactivate,
	setProject,
	updateProjectRegistry,
} from "./handlers.ts";
import { projectCreate } from "./lifecycle-handlers.ts";
import { authorizeOperatorByToken } from "../../../server/operator-auth.ts";

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
			"Create a new project with transactional safety (P483 Phase 1). Validates slug, creates DB registry entry, queues worktree directory creation. Returns {ok, project, worktree_created, repair_needed, note}. Pre-freezes signature for P432 project_attach. P3508 AC-6: pass operator_token to enforce project.create ACL from MCP callers.",
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
						"(Optional) Custom worktree root path. If omitted, defaults to AGENTHIVE_WORKTREES_ROOT or /data/code plus /<slug>/worktree.",
				},
				default_workflow_template: {
					type: "string",
					description:
						"(Optional) Workflow template to clone for new project. Deferred to P483 Phase 2 (requires workflow_templates composite PK).",
				},
				operator_token: {
					type: "string",
					description:
						"(Optional, P3508 AC-6) Raw operator bearer token. If provided, checked against allowed_actions=['project.create']. Missing token is allowed only when no operator tokens are configured (open-mode).",
				},
			},
			required: ["slug", "name"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			// P3508 AC-6: gate project creation behind operator token when provided.
			const rawToken = args.operator_token as string | undefined;
			if (rawToken) {
				const outcome = await authorizeOperatorByToken(rawToken, {
					action: "project.create",
					targetKind: "project",
					targetIdentity: args.slug as string | undefined,
					requestSummary: { slug: args.slug, name: args.name },
				});
				if (outcome.decision !== "allow") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									ok: false,
									error: outcome.failureReason ?? "Forbidden",
									decision: outcome.decision,
									action: "project.create",
									http_status: outcome.httpStatus,
								}, null, 2),
							},
						],
					};
				}
			}
			return projectCreate({
				slug: args.slug as string | undefined,
				name: args.name as string | undefined,
				worktree_root: args.worktree_root as string | undefined,
				default_workflow_template: args.default_workflow_template as
					| string
					| undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_health_check",
		description:
			"P516: Validate project registry and tenant worktree sync. Returns ERROR_WORKTREE_NOT_FOUND when the configured worktree_root is absent.",
		inputSchema: {
			type: "object",
			properties: {
				project_id: {
					type: "number",
					description: "Project ID from roadmap.project.",
				},
				project: {
					type: "string",
					description: "Project slug or numeric id.",
				},
			},
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return projectHealthCheck({
				project_id: args.project_id as number | undefined,
				project: args.project as string | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_update",
		description:
			"P516: Update tenant repository registry fields on roadmap.project. Supports git_repo_url, git_default_branch, and worktree_root.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project slug or numeric project_id.",
				},
				git_repo_url: {
					type: "string",
					description: "Tenant git repository remote URL.",
				},
				git_default_branch: {
					type: "string",
					description: "Tenant repository default branch.",
				},
				worktree_root: {
					type: "string",
					description: "Tenant worktree root path.",
				},
			},
			required: ["project"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return updateProjectRegistry({
				project: args.project as string | undefined,
				git_repo_url: args.git_repo_url as string | null | undefined,
				git_default_branch: args.git_default_branch as string | undefined,
				worktree_root: args.worktree_root as string | undefined,
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
					description:
						"Route name (e.g., 'claude-opus', 'gpt-4'). Case-sensitive.",
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
					description:
						"Capability name (e.g., 'web_search', 'knowledge_retrieve'). Case-sensitive.",
				},
				max_concurrency: {
					type: "number",
					description:
						"(Optional) Max concurrent instances of this capability.",
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
					description:
						"Max USD cents allowed for this period (e.g., 5000 for $50).",
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

	server.addTool({
		name: "project_archive",
		description:
			"Archive a project (AC-3). Sets status=archived and dispatch handler refuses claims for archived projects. Returns {ok, project, message}.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project slug or numeric project_id.",
				},
				reason: {
					type: "string",
					description:
						"(Optional) Reason for archiving. Default: 'Archived by operator'.",
				},
			},
			required: ["project"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return projectArchive({
				project: args.project as string | undefined,
				reason: args.reason as string | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_reactivate",
		description:
			"Reactivate an archived project (AC-3). Sets status=active and clears archived_at. Returns {ok, project, message}.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project slug or numeric project_id.",
				},
			},
			required: ["project"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return projectReactivate({
				project: args.project as string | undefined,
			});
		},
	} as McpToolHandler);

	server.addTool({
		name: "project_delete",
		description:
			"Delete a project with safety guards (AC-4). Refuses unless (a) zero non-archived proposals AND (b) confirm_slug matches. Performs cascade delete on routes, capabilities, budgets. Returns {ok, deleted, message}.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project slug or numeric project_id.",
				},
				confirm_slug: {
					type: "string",
					description:
						"Must match the project slug exactly to proceed. Prevents accidental deletion.",
				},
				force: {
					type: "boolean",
					description:
						"(Optional) If true, cascade-delete dependent rows (cubics, channels, templates). Default: false (block on dependencies).",
				},
			},
			required: ["project", "confirm_slug"],
		},
		async handler(args: Record<string, unknown>): Promise<CallToolResult> {
			return projectDelete({
				project: args.project as string | undefined,
				confirm_slug: args.confirm_slug as string | undefined,
				force: args.force as boolean | undefined,
			});
		},
	} as McpToolHandler);
}
