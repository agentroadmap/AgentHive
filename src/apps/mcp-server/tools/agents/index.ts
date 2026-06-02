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
	agencyResumeSchema,
	agencyStartSchema,
	agencyStatusSchema,
	agentAssignSchema,
	agentForceReleaseAliasSchema,
	agentGetSchema,
	agentHeartbeatSchema,
	agentListSchema,
	agentRegisterModelSchema,
	agentRegisterSchema,
	agentRenameSchema,
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
	const registerTool: McpToolHandler =
		createSimpleValidatedTool<RegisterAgentArgs>(
			{
				name: "agent_register",
				description:
					"Register or update an agent profile in the dynamic multi-model pool. " +
					"Supports Claude, GPT, Gemini, local models, and custom AI backends.",
				inputSchema: agentRegisterSchema,
			},
			agentRegisterSchema,
			async (input) => handlers.registerAgent(input),
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

	// ── agent_rename ────────────────────────────────────────────────────────
	type RenameAgentArgs = Parameters<PgAgentHandlers["renameAgent"]>[0];
	const renameTool: McpToolHandler = createSimpleValidatedTool<RenameAgentArgs>(
		{
			name: "agent_rename",
			description:
				"P925: Rename the display_alias of a permanent agent (Tier 1 / Tier 2). " +
				"Accepts agent_identity OR current display_alias as the lookup key. " +
				"Validates format (^[A-Z][A-Za-z0-9-]{2,63}$), checks collision, and writes via audit-logged UPDATE. " +
				"Returns { identity, prior_alias, new_alias, audit_id }.",
			inputSchema: agentRenameSchema,
		},
		agentRenameSchema,
		async (input) => pgHandlers.renameAgent(input),
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

	// ── agency_resume ───────────────────────────────────────────────────────
	type AgencyResumeArgs = Parameters<PgAgentHandlers["resumeAgency"]>[0];
	const agencyResumeTool: McpToolHandler =
		createSimpleValidatedTool<AgencyResumeArgs>(
			{
				name: "agency_resume",
				description:
					"P765 AC-2: Operator short-circuit — force an offline/dormant/throttled " +
					"agency back to 'active' without waiting for the two-step heartbeat recovery. " +
					"Updates both roadmap.agency and provider_registry. Clears the offline alert " +
					"flag so the next offline episode emits a fresh alert.",
				inputSchema: agencyResumeSchema,
			},
			agencyResumeSchema,
			async (input) => pgHandlers.resumeAgency(input),
		);

	// Register all tools
	server.addTool(registerTool);
	server.addTool(getTool);
	server.addTool(listTool);
	server.addTool(assignTool);
	server.addTool(heartbeatTool);
	server.addTool(spawnTool);
	server.addTool(retireTool);
	server.addTool(renameTool);
	server.addTool(forceReleaseAliasTool);
	server.addTool(zombieDetectTool);
	server.addTool(poolStatsTool);
	server.addTool(agencyResumeTool);

	// ── agent_register_model ────────────────────────────────────────────────
	type RegisterModelArgs = Parameters<PgAgentHandlers["registerModel"]>[0];
	const registerModelTool: McpToolHandler =
		createSimpleValidatedTool<RegisterModelArgs>(
			{
				name: "agent_register_model",
				description:
					"P1129 AC-2: Agency self-declares a model it supports. Upserts into " +
					"roadmap.model_routes. Pass probe=true to run a CLI liveness check " +
					"(`<agent_cli> --model <model_name> -p x`) before registering.",
				inputSchema: agentRegisterModelSchema,
			},
			agentRegisterModelSchema,
			async (input) => pgHandlers.registerModel(input),
		);

	// ── agency_start ────────────────────────────────────────────────────────
	type AgencyStartArgs = Parameters<PgAgentHandlers["agencyStart"]>[0];
	const agencyStartTool: McpToolHandler =
		createSimpleValidatedTool<AgencyStartArgs>(
			{
				name: "agency_start",
				description:
					"P1129 AC-3: Start the liaison systemd service for an agency " +
					"(agenthive-agency@<identity>.service). Optionally writes an env file " +
					"with AGENTHIVE_PROVIDER / AGENTHIVE_WORKTREE before starting.",
				inputSchema: agencyStartSchema,
			},
			agencyStartSchema,
			async (input) => pgHandlers.agencyStart(input),
		);

	// ── agency_status ────────────────────────────────────────────────────────
	type AgencyStatusArgs = Parameters<PgAgentHandlers["agencyStatus"]>[0];
	const agencyStatusTool: McpToolHandler =
		createSimpleValidatedTool<AgencyStatusArgs>(
			{
				name: "agency_status",
				description:
					"P1129 AC-4: Per-agency runtime state — DB row (status, last_heartbeat_at), " +
					"open liaison session, and systemd ActiveState in one response.",
				inputSchema: agencyStatusSchema,
			},
			agencyStatusSchema,
			async (input) => pgHandlers.agencyStatus(input),
		);

	server.addTool(registerModelTool);
	server.addTool(agencyStartTool);
	server.addTool(agencyStatusTool);

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
