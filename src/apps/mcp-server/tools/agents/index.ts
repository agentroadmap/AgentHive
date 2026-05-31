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
	agentPgRegisterSchema,
	agentRegisterModelSchema,
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
	type RegisterAgentArgs = Parameters<PgAgentHandlers["registerAgent"]>[0];
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
	// P1129: switched to pgHandlers so agency-shape fields persist in agent_registry
	const registerTool: McpToolHandler =
		createSimpleValidatedTool<RegisterAgentArgs>(
			{
				name: "agent_register",
				description:
					"Register or update an agent in the Postgres-backed registry. " +
					"Supports Claude, GPT, Gemini, local models, and custom AI backends. " +
					"P1129: persists preferred_provider, agent_cli, host_affinity, display_alias.",
				inputSchema: agentRegisterSchema,
			},
			agentRegisterSchema,
			async (input) => {
				// Map schema fields → pgHandlers signature
				const mapped: RegisterAgentArgs = {
					identity: (input as any).identity || (input as any).name,
					agent_type: (input as any).template || (input as any).agent_type || "agency",
					role: (input as any).role,
					skills: (input as any).capabilities
						? JSON.stringify((input as any).capabilities)
						: undefined,
					preferred_provider:
						(input as any).preferred_provider || (input as any).provider,
					agent_cli: (input as any).agent_cli,
					host_affinity: (input as any).host_affinity,
					display_alias: (input as any).display_alias,
					display_name: (input as any).name !== (input as any).identity
						? (input as any).name
						: undefined,
				};
				return pgHandlers.registerAgent(mapped);
			},
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

	// ── agent_register_agency ───────────────────────────────────────────────
	type RegisterAgencyArgs = Parameters<PgAgentHandlers["registerAgency"]>[0];
	const registerAgencyTool: McpToolHandler =
		createSimpleValidatedTool<RegisterAgencyArgs>(
			{
				name: "agent_register_agency",
				description:
					"P1372: Register an agency in roadmap.agency. Validates that the agency_id exists in agent_registry as an active agency, " +
					"then idempotently inserts into roadmap.agency. Accepts agent_identity (canonical), identity, or agency_id as identifier aliases.",
				inputSchema: {
					type: "object",
					properties: {
						agent_identity: {
							type: "string",
							description: "Agency identity (canonical name)",
						},
						identity: {
							type: "string",
							description: "Agency identity (alias)",
						},
						agency_id: {
							type: "string",
							description: "Agency identity (alias)",
						},
						display_name: {
							type: "string",
							description: "Display name; defaults to agent_identity",
						},
						provider: {
							type: "string",
							description:
								"Provider name; defaults to agent_registry.preferred_provider",
						},
						host_id: {
							type: "string",
							description:
								"Host ID; defaults to agent_registry.host_affinity then 'bot'",
						},
						metadata: {
							type: "object",
							description:
								"Additional metadata (must be an object, not array)",
							additionalProperties: true,
						},
					},
				},
			},
			{
				type: "object",
				additionalProperties: true,
			},
			async (input) => pgHandlers.registerAgency(input),
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

	// Register all tools
	server.addTool(registerTool);
	server.addTool(getTool);
	server.addTool(listTool);
	server.addTool(assignTool);
	server.addTool(heartbeatTool);
	server.addTool(spawnTool);
	server.addTool(retireTool);
	server.addTool(resolveAgentTool);
	server.addTool(registerAgencyTool);
	server.addTool(forceReleaseAliasTool);
	server.addTool(zombieDetectTool);
	server.addTool(poolStatsTool);

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

	// ── agent_register_model ────────────────────────────────────────────────
	// P1129: register a model into model_metadata + model_routes with CLI probe gate
	type RegisterModelArgs = Parameters<PgAgentHandlers["registerModel"]>[0];
	const registerModelTool = createSimpleValidatedTool<RegisterModelArgs>(
		{
			name: "agent_register_model",
			description:
				"P1129: Register a model into roadmap.model_metadata + model_routes with a live CLI probe. " +
				"Requires agent_identity + model_name + route_provider + agent_provider. " +
				"Set skip_probe=true only when caller has trust_tier='authority'.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Caller identity from agent_registry",
					},
					model_name: { type: "string", description: "Model identifier (e.g. claude-opus-4-7)" },
					route_provider: { type: "string", description: "Provider in model_metadata (e.g. 'anthropic')" },
					agent_provider: { type: "string", description: "LLM runtime (e.g. 'claude', 'codex')" },
					agent_cli: { type: "string", description: "Override CLI path (falls back to agent_registry.agent_cli)" },
					base_url: { type: "string", description: "Custom API base URL" },
					api_spec: { type: "string", description: "API spec / variant (e.g. 'openai-compatible')" },
					tier: {
						type: "string",
						enum: ["frontier", "mid", "lower", "tool"],
						description: "Model tier (model_routes.tier)",
					},
					skip_probe: {
						type: "boolean",
						description: "Bypass CLI probe. Requires trust_tier='authority' in agent_registry.",
					},
				},
				required: ["agent_identity", "model_name", "route_provider", "agent_provider"],
			},
		},
		{
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				model_name: { type: "string" },
				route_provider: { type: "string" },
				agent_provider: { type: "string" },
			},
			required: ["agent_identity", "model_name", "route_provider", "agent_provider"],
		},
		async (input) => pgHandlers.registerModel(input),
	);
	server.addTool(registerModelTool);

	// ── agent_pg_register ───────────────────────────────────────────────────
	// P1129: Clean DB-backed registration with identity as the primary key.
	// Unlike agent_register (legacy schema compatibility), this tool's schema
	// maps 1-to-1 with agent_registry columns — use for new agency onboarding.
	type PgRegisterArgs = Parameters<PgAgentHandlers["registerAgent"]>[0];
	const pgRegisterTool = createSimpleValidatedTool<PgRegisterArgs>(
		{
			name: "agent_pg_register",
			description:
				"P1129: Self-service agency registration. Upserts a row in agent_registry with full " +
				"agency-shape fields: identity (required), agent_type, role, skills, preferred_provider, " +
				"agent_cli, host_affinity, display_alias, display_name. Uses COALESCE ON CONFLICT — " +
				"omitted fields preserve existing values.",
			inputSchema: agentPgRegisterSchema,
		},
		agentPgRegisterSchema,
		async (input) => pgHandlers.registerAgent(input as PgRegisterArgs),
	);
	server.addTool(pgRegisterTool);
}
