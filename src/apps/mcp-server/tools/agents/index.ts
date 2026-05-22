/**
 * STATE-77: Agent Pool MCP Tools - Dynamic Multi-Model Agent Registry
 *
 * Registers all agent pool management tools with the MCP server.
 * Supports: Claude, GPT, Gemini, local models, and custom AI backends.
 */

import type { McpServer } from "../../server.ts";
import type { CallToolResult, McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import {
	AgentPoolHandlers,
	grantPrivilege,
	revokePrivilege,
	updateReporting,
} from "./handlers.ts";
import { PgAgentHandlers } from "./pg-handlers.ts";
import {
	agentAssignSchema,
	agentForceReleaseAliasSchema,
	agentGetSchema,
	agentHeartbeatSchema,
	agentListSchema,
	agentRegisterSchema,
	agentRetireSchema,
	agentSpawnSchema,
} from "./schemas.ts";

/**
 * AC#6: MCP commands: agent create, agent list, agent assign
 * Registers all agent pool tools with the MCP server.
 */
export function registerAgentTools(server: McpServer): void {
	const handlers = new AgentPoolHandlers(server);
	const pgHandlers = new PgAgentHandlers();
	type RegisterAgentArgs = Parameters<AgentPoolHandlers["registerAgent"]>[0];
	type GetAgentArgs = Parameters<AgentPoolHandlers["getAgent"]>[0];
	type ListAgentsArgs = Parameters<AgentPoolHandlers["listAgents"]>[0];
	type AssignWorkArgs = Parameters<AgentPoolHandlers["assignWork"]>[0];
	type HeartbeatArgs = Parameters<AgentPoolHandlers["heartbeat"]>[0];
	type SpawnAgentArgs = Parameters<AgentPoolHandlers["spawnAgent"]>[0];
	type RetireAgentArgs = Parameters<AgentPoolHandlers["retireAgent"]>[0];
	type UpdateReportingArgs = Parameters<typeof updateReporting>[0];
	type GrantPrivilegeArgs = Parameters<typeof grantPrivilege>[0];
	type RevokePrivilegeArgs = Parameters<typeof revokePrivilege>[0];

	// ── agent_register ──────────────────────────────────────────────────────
	// P1129: now routes to pgHandlers so preferred_provider / agent_cli /
	// host_affinity / display_alias are persisted in agent_registry.
	const registerTool: McpToolHandler =
		createSimpleValidatedTool<RegisterAgentArgs>(
			{
				name: "agent_register",
				description:
					"Register or update an agent in agent_registry (DB-backed). " +
					"Required: identity. Optional: agent_type, role, skills, preferred_provider, agent_cli, host_affinity, display_alias, display_name.",
				inputSchema: agentRegisterSchema,
			},
			agentRegisterSchema,
			async (input) => pgHandlers.registerAgent(input as Parameters<PgAgentHandlers["registerAgent"]>[0]),
		);

	// ── agent_get ────────────────────────────────────────────────────────────
	const getTool: McpToolHandler = createSimpleValidatedTool<GetAgentArgs>(
		{
			name: "agent_get",
			description:
				"Get detailed information about a specific agent by ID. " +
				"P054: Returns agent status, capabilities, activity metrics, and timeline.",
			inputSchema: agentGetSchema,
		},
		agentGetSchema,
		async (input) => handlers.getAgent(input),
	);

	// ── agent_list ──────────────────────────────────────────────────────────
	const listTool: McpToolHandler = createSimpleValidatedTool<ListAgentsArgs>(
		{
			name: "agent_list",
			description:
				"List all registered agents with filtering by status, provider, template, or capabilities. " +
				"AC#4: Queries agents from DB instead of config files.",
			inputSchema: agentListSchema,
		},
		agentListSchema,
		async (input) => handlers.listAgents(input),
	);

	// ── agent_assign ────────────────────────────────────────────────────────
	const assignTool: McpToolHandler = createSimpleValidatedTool<AssignWorkArgs>(
		{
			name: "agent_assign",
			description:
				"Assign a roadmap proposal to an agent for work. Creates a claim with TTL. " +
				"Rejects if agent is offline or proposal is already claimed.",
			inputSchema: agentAssignSchema,
		},
		agentAssignSchema,
		async (input) => handlers.assignWork(input),
	);

	// ── agent_heartbeat ─────────────────────────────────────────────────────
	const heartbeatTool: McpToolHandler =
		createSimpleValidatedTool<HeartbeatArgs>(
			{
				name: "agent_heartbeat",
				description:
					"Send a heartbeat from an agent to keep it alive in the pool. " +
					"AC#5: Used for stale-agent detection after an extended inactivity window.",
				inputSchema: agentHeartbeatSchema,
			},
			agentHeartbeatSchema,
			async (input) => handlers.heartbeat(input),
		);

	// ── agent_spawn ─────────────────────────────────────────────────────────
	const spawnTool: McpToolHandler = createSimpleValidatedTool<SpawnAgentArgs>(
		{
			name: "agent_spawn",
			description:
				"Request to spawn a new agent with specified template and model. " +
				"Creates a spawn request that can be approved/denied by orchestrator.",
			inputSchema: agentSpawnSchema,
		},
		agentSpawnSchema,
		async (input) => handlers.spawnAgent(input),
	);

	// ── agent_retire ────────────────────────────────────────────────────────
	const retireTool: McpToolHandler = createSimpleValidatedTool<RetireAgentArgs>(
		{
			name: "agent_retire",
			description:
				"Retire an agent from the pool. Optionally release all active claims.",
			inputSchema: agentRetireSchema,
		},
		agentRetireSchema,
		async (input) => handlers.retireAgent(input),
	);

	// ── agent_resolve ───────────────────────────────────────────────────────
	type ResolveAgentArgs = Parameters<PgAgentHandlers["resolveAgent"]>[0];
	const resolveAgentTool: McpToolHandler =
		createSimpleValidatedTool<ResolveAgentArgs>(
			{
				name: "agent_resolve",
				description:
					"P995: Resolve a named agent by agent_identity or display_alias. " +
					"Returns registry row including preferred_provider, host_affinity, and status. " +
					"Use this to verify an agent is registered before sending it a message.",
				inputSchema: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "agent_identity (e.g. 'adam') or display_alias to look up",
						},
					},
					required: ["name"],
				},
			},
			{
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			},
			async (input) => pgHandlers.resolveAgent(input),
		);

	// ── agent_force_release_alias ───────────────────────────────────────────
	type ForceReleaseAliasArgs = Parameters<
		PgAgentHandlers["forceReleaseAlias"]
	>[0];
	const forceReleaseAliasTool: McpToolHandler =
		createSimpleValidatedTool<ForceReleaseAliasArgs>(
			{
				name: "agent_force_release_alias",
				description:
					"P919: Force-release a display alias from an agent. " +
					"Two paths: (1) clean reclaim if target is inactive; (2) stuck-active reclaim if force=true and heartbeat > 90s.",
				inputSchema: agentForceReleaseAliasSchema,
			},
			agentForceReleaseAliasSchema,
			async (input) => pgHandlers.forceReleaseAlias(input),
		);

	// ── agent_zombie_detect ─────────────────────────────────────────────────
	const zombieDetectTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_zombie_detect",
			description:
				"Scan for stale agents after the inactivity window and mark them offline. " +
				"AC#5: Stale-agent detection via heartbeat timestamps.",
			inputSchema: { type: "object", properties: {} },
		},
		{ type: "object", properties: {} },
		async () => handlers.detectZombies(),
	);

	// ── agent_pool_stats ────────────────────────────────────────────────────
	const poolStatsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "agent_pool_stats",
			description:
				"Get statistics about the agent pool: counts by status, provider, template, and trust scores.",
			inputSchema: { type: "object", properties: {} },
		},
		{ type: "object", properties: {} },
		async () => handlers.getPoolStats(),
	);

	// ── agency_resume ────────────────────────────────────────────────────────
	// P765 AC-2: operator short-circuit resume for offline/dormant agencies.
	type AgencyResumeArgs = Parameters<PgAgentHandlers["agencyResume"]>[0];
	const agencyResumeTool: McpToolHandler =
		createSimpleValidatedTool<AgencyResumeArgs>(
			{
				name: "agency_resume",
				description:
					"P765: Operator short-circuit recovery — force an offline or dormant agency back to active " +
					"in provider_registry, clear the offline alert flag, and post a Discord resolved notice.",
				inputSchema: {
					type: "object",
					properties: {
						agency_identity: {
							type: "string",
							description: "agency_identity of the agency to resume",
						},
					},
					required: ["agency_identity"],
				},
			},
			{
				type: "object",
				properties: { agency_identity: { type: "string" } },
				required: ["agency_identity"],
			},
			async (input) => pgHandlers.agencyResume(input),
		);

	// ── agent_register_model ─────────────────────────────────────────────────
	// P1129 Phase B: register a model route (upserts model_metadata + model_routes).
	type RegisterModelArgs = Parameters<PgAgentHandlers["registerModel"]>[0];
	const registerModelTool: McpToolHandler =
		createSimpleValidatedTool<RegisterModelArgs>(
			{
				name: "agent_register_model",
				description:
					"P1129: Register a model route for an agency. " +
					"Upserts model_metadata then model_routes so the resolver can dispatch to this model. " +
					"Required: provider, model_name. Optional: route_provider, agent_provider, base_url, priority, cost_per_1k_tokens.",
				inputSchema: {
					type: "object",
					properties: {
						provider: { type: "string", description: "Provider key (e.g. 'claude', 'gemini', 'copilot')" },
						model_name: { type: "string", description: "Model name (e.g. 'claude-sonnet-4-5', 'gemini-2.0-flash')" },
						route_provider: { type: "string", description: "route_provider override (defaults to provider)" },
						agent_provider: { type: "string", description: "agent_provider override (defaults to provider)" },
						base_url: { type: "string", description: "Optional custom API base URL" },
						priority: { type: "number", description: "Route priority (higher = preferred, default 50)" },
						cost_per_1k_tokens: { type: "number", description: "Cost per 1k tokens for budget tracking" },
					},
					required: ["provider", "model_name"],
					additionalProperties: false,
				},
			},
			{
				type: "object",
				properties: {
					provider: { type: "string" },
					model_name: { type: "string" },
					route_provider: { type: "string" },
					agent_provider: { type: "string" },
					base_url: { type: "string" },
					priority: { type: "number" },
					cost_per_1k_tokens: { type: "number" },
				},
				required: ["provider", "model_name"],
			},
			async (input) => pgHandlers.registerModel(input),
		);

	// Register all tools
	server.addTool(registerModelTool);
	server.addTool(registerTool);
	server.addTool(getTool);
	server.addTool(listTool);
	server.addTool(assignTool);
	server.addTool(heartbeatTool);
	server.addTool(spawnTool);
	server.addTool(retireTool);
	server.addTool(resolveAgentTool);
	server.addTool(forceReleaseAliasTool);
	server.addTool(zombieDetectTool);
	server.addTool(poolStatsTool);
	server.addTool(agencyResumeTool);

	// ── agent_update_reporting ──────────────────────────────────────────────
	const reportingTool = createSimpleValidatedTool<UpdateReportingArgs>(
		{
			name: "agent_update_reporting",
			description: "Update who an agent reports to in the reporting hierarchy.",
			inputSchema: {
				type: "object",
				properties: {
					agentId: { type: "string", description: "Agent ID" },
					managerId: {
						type: "string",
						description: "Manager ID (null for top-level)",
					},
				},
				required: ["agentId"],
			},
		},
		{
			type: "object",
			properties: {
				agentId: { type: "string" },
				managerId: { type: "string" },
			},
		},
		async (input) => updateReporting(input) as Promise<CallToolResult>,
	);

	// ── privilege_grant ─────────────────────────────────────────────────────
	const grantTool = createSimpleValidatedTool<GrantPrivilegeArgs>(
		{
			name: "privilege_grant",
			description:
				"Grant a privilege (read/edit/claim/review/admin/budget) to an agent.",
			inputSchema: {
				type: "object",
				properties: {
					agentId: { type: "string", description: "Agent ID" },
					permission: {
						type: "string",
						enum: ["read", "edit", "claim", "review", "admin", "budget"],
					},
					grantedBy: { type: "string", description: "Who granted" },
				},
				required: ["agentId", "permission", "grantedBy"],
			},
		},
		{
			type: "object",
			properties: {
				agentId: { type: "string" },
				permission: { type: "string" },
				grantedBy: { type: "string" },
			},
		},
		async (input) => grantPrivilege(input) as Promise<CallToolResult>,
	);

	// ── privilege_revoke ────────────────────────────────────────────────────
	const revokeTool = createSimpleValidatedTool<RevokePrivilegeArgs>(
		{
			name: "privilege_revoke",
			description: "Revoke a privilege by ID.",
			inputSchema: {
				type: "object",
				properties: { privilegeId: { type: "number" } },
				required: ["privilegeId"],
			},
		},
		{ type: "object", properties: { privilegeId: { type: "number" } } },
		async (input) => revokePrivilege(input) as Promise<CallToolResult>,
	);

	server.addTool(reportingTool);
	server.addTool(grantTool);
	server.addTool(revokeTool);
}
