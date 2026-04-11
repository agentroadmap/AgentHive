/**
 * STATE-77: Agent Pool MCP Handlers
 * Dynamic multi-model agent pool management backed by in-memory state.
 */

import type { AgentStatus } from "../../../../shared/types/index.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export type McpAgentStatus = AgentStatus | "online" | "busy" | "error";

export type AgentProvider =
	| "anthropic"
	| "openai"
	| "google"
	| "local"
	| "custom";

export interface AgentConfig {
	baseUrl?: string;
	temperature?: number;
	maxTokens?: number;
	rateLimitPerMinute?: number;
	timeoutMs?: number;
	tags?: Record<string, string>;
}

export interface AgentProfile {
	id: string;
	template: string;
	model: string;
	provider: AgentProvider;
	status: McpAgentStatus;
	capabilities: string[];
	identity: string;
	workspace: string;
	machineId: string;
	heartbeatAt: string;
	createdAt: string;
	updatedAt: string;
	config: AgentConfig;
	trustScore: number;
	claimsCount: number;
	completedCount: number;
	errorCount: number;
	lastError?: string;
}

export interface AgentWorkClaim {
	id: string;
	agentId: string;
	proposalId: string;
	claimedAt: string;
	heartbeatAt: string;
	expiresAt: string;
	priority: "critical" | "high" | "normal" | "low";
	notes?: string;
}

// Extended agent type for multi-model support
export interface MultiModelAgent extends AgentProfile {
	name?: string;
	lastSeen?: string;
}

const STALE_AGENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export class AgentPoolHandlers {
	private server: McpServer;
	// In-memory state for the local agent pool.
	private agents: Map<string, MultiModelAgent> = new Map();
	private claims: Map<string, AgentWorkClaim> = new Map();
	private spawnRequests: Map<string, unknown> = new Map();

	constructor(server: McpServer) {
		this.server = server;
	}

	/**
	 * AC#3: Any AI (Claude, GPT, Gemini, local) can register via API
	 */
	async registerAgent(args: {
		id?: string;
		name: string;
		template: string;
		model: string;
		provider: AgentProvider;
		identity?: string;
		workspace?: string;
		machineId?: string;
		capabilities?: string[];
		config?: {
			baseUrl?: string;
			temperature?: number;
			maxTokens?: number;
			rateLimitPerMinute?: number;
			timeoutMs?: number;
		};
	}): Promise<CallToolResult> {
		try {
			const id = args.id ?? `${args.provider}-${args.template}-${Date.now()}`;
			const now = new Date().toISOString();

			const agent: MultiModelAgent = {
				id,
				template: args.template,
				model: args.model,
				provider: args.provider,
				status: "online",
				capabilities: args.capabilities ?? [],
				identity: args.identity ?? "",
				workspace: args.workspace ?? "",
				machineId: args.machineId ?? "unknown",
				heartbeatAt: now,
				createdAt: now,
				updatedAt: now,
				config: args.config ?? {},
				trustScore: 50,
				claimsCount: 0,
				completedCount: 0,
				errorCount: 0,
			};

			this.agents.set(id, agent);

			// Sync with existing server registry if possible
			try {
				await this.server.registerAgent({
					name: args.name,
					identity: args.identity,
					capabilities: args.capabilities ?? [],
					status: "idle",
					costClass: this.estimateCostClass(args.model, args.provider),
				});
			} catch {
				// Non-critical: server registry is optional fallback
			}

			const providerEmoji = this.providerEmoji(args.provider);
			const statusEmoji = this.statusEmoji(agent.status);

			return {
				content: [
					{
						type: "text",
						text: [
							`${statusEmoji} Agent registered successfully!`,
							`ID: ${id}`,
							`Template: ${args.template}`,
							`Model: ${providerEmoji} ${args.model} (${args.provider})`,
							`Capabilities: ${args.capabilities?.join(", ") ?? "none"}`,
							`Status: ${agent.status}`,
							args.config?.baseUrl ? `Endpoint: ${args.config.baseUrl}` : "",
							"",
							"Agent is now available for work assignments.",
							"Send heartbeats to stay online.",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#6: MCP command for agent list
	 */
	async listAgents(args: {
		status?: AgentStatus;
		provider?: AgentProvider;
		template?: string;
		capabilities?: string[];
	}): Promise<CallToolResult> {
		try {
			let filteredAgents = Array.from(this.agents.values());

			// Apply filters
			if (args.status) {
				filteredAgents = filteredAgents.filter((a) => a.status === args.status);
			}
			if (args.provider) {
				filteredAgents = filteredAgents.filter(
					(a) => a.provider === args.provider,
				);
			}
			if (args.template) {
				filteredAgents = filteredAgents.filter(
					(a) => a.template === args.template,
				);
			}
			if (args.capabilities?.length) {
				filteredAgents = filteredAgents.filter((a) =>
					args.capabilities?.every((cap) => a.capabilities.includes(cap)),
				);
			}

			if (filteredAgents.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No agents matching the specified criteria.\n\nUse agent_register to add agents to the pool.",
						},
					],
				};
			}

			// Sort: idle/online first, then by trust score
			filteredAgents.sort((a, b) => {
				const statusOrder: Record<McpAgentStatus, number> = {
					active: 0,
					idle: 1,
					online: 2,
					busy: 3,
					error: 4,
					offline: 5,
				};
				if (statusOrder[a.status] !== statusOrder[b.status]) {
					return statusOrder[a.status] - statusOrder[b.status];
				}
				return b.trustScore - a.trustScore;
			});

			const lines = [
				"🤖 Agent Pool Status",
				`${"─".repeat(40)}`,
				`Total: ${filteredAgents.length} agents`,
				`Idle: ${filteredAgents.filter((a) => a.status === "idle").length} | ` +
					`Busy: ${filteredAgents.filter((a) => a.status === "busy").length} | ` +
					`Online: ${filteredAgents.filter((a) => a.status === "online").length}`,
				"",
			];

			for (const agent of filteredAgents) {
				const statusIcon = this.statusEmoji(agent.status);
				const providerIcon = this.providerEmoji(agent.provider);

				lines.push(
					`${statusIcon} ${agent.id}`,
					`   Template: ${agent.template}`,
					`   Model: ${providerIcon} ${agent.model} (${agent.provider})`,
					`   Status: ${agent.status} | Claims: ${agent.claimsCount} | Completed: ${agent.completedCount}`,
					`   Capabilities: ${agent.capabilities.join(", ") || "none"}`,
					`   Trust: ${agent.trustScore}/100`,
					`   Last heartbeat: ${agent.heartbeatAt}`,
					agent.lastError ? `   ⚠️  ${agent.lastError}` : "",
					"",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * P054: Get details for a specific agent by ID.
	 */
	async getAgent(args: { agentId: string }): Promise<CallToolResult> {
		try {
			const agent = this.agents.get(args.agentId);

			if (!agent) {
				return {
					content: [
						{
							type: "text",
							text: `Agent "${args.agentId}" not found in registry.\n\nUse agent_list to see all registered agents, or agent_register to add a new agent.`,
						},
					],
					isError: true,
				};
			}

			const statusIcon = this.statusEmoji(agent.status);
			const providerIcon = this.providerEmoji(agent.provider);

			const lines = [
				`${statusIcon} Agent: ${agent.id}`,
				`${"─".repeat(40)}`,
				`Template: ${agent.template}`,
				`Model: ${providerIcon} ${agent.model} (${agent.provider})`,
				`Status: ${agent.status}`,
				`Capabilities: ${agent.capabilities.join(", ") || "none"}`,
				`Trust Score: ${agent.trustScore}/100`,
				``,
				`📊 Activity:`,
				`   Claims: ${agent.claimsCount}`,
				`   Completed: ${agent.completedCount}`,
				`   Errors: ${agent.errorCount}`,
				agent.lastError ? `   ⚠️  Last Error: ${agent.lastError}` : "",
				``,
				`📅 Timeline:`,
				`   Created: ${agent.createdAt}`,
				`   Last Heartbeat: ${agent.heartbeatAt}`,
				`   Updated: ${agent.updatedAt}`,
			].filter((l) => l !== "");

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#6: MCP command for agent assign (claim work)
	 */
	async assignWork(args: {
		agentId: string;
		proposalId: string;
		priority?: "critical" | "high" | "normal" | "low";
		notes?: string;
		ttlMinutes?: number;
	}): Promise<CallToolResult> {
		try {
			const agent = this.agents.get(args.agentId);
			if (!agent) {
				throw new McpError(
					`Agent ${args.agentId} not found in registry`,
					"NOT_FOUND",
				);
			}

			if (agent.status === "offline" || agent.status === "error") {
				throw new McpError(
					`Agent ${args.agentId} is ${agent.status} and cannot accept work`,
					"INVALID_STATE",
				);
			}

			// Check if proposal already claimed
			for (const claim of this.claims.values()) {
				if (claim.proposalId === args.proposalId) {
					const claimExpiry = new Date(claim.expiresAt).getTime();
					if (claimExpiry > Date.now()) {
						throw new McpError(
							`Proposal ${args.proposalId} already claimed by ${claim.agentId}`,
							"CONFLICT",
						);
					}
					// Expired claim - remove it
					this.claims.delete(claim.id);
				}
			}

			const now = new Date();
			const ttlMs = (args.ttlMinutes ?? 60) * 60000;
			const claimId = `claim-${args.agentId}-${args.proposalId}-${now.getTime()}`;

			const claim: AgentWorkClaim = {
				id: claimId,
				agentId: args.agentId,
				proposalId: args.proposalId,
				claimedAt: now.toISOString(),
				heartbeatAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
				priority: args.priority ?? "normal",
				notes: args.notes,
			};

			this.claims.set(claimId, claim);

			// Update agent
			agent.claimsCount++;
			agent.status = "busy";
			agent.updatedAt = now.toISOString();

			return {
				content: [
					{
						type: "text",
						text: [
							`✅ Work assigned successfully!`,
							`Agent: ${args.agentId} (${agent.model})`,
							`Proposal: ${args.proposalId}`,
							`Priority: ${claim.priority}`,
							`Expires: ${claim.expiresAt}`,
							args.notes ? `Notes: ${args.notes}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#5: Heartbeat handling for zombie detection
	 */
	async heartbeat(args: {
		agentId: string;
		load: number;
		claimsCount: number;
		latencyMs?: number;
	}): Promise<CallToolResult> {
		try {
			const agent = this.agents.get(args.agentId);
			if (!agent) {
				throw new McpError(`Agent ${args.agentId} not registered`, "NOT_FOUND");
			}

			const now = new Date().toISOString();
			agent.heartbeatAt = now;
			agent.updatedAt = now;
			agent.claimsCount = args.claimsCount;
			agent.status =
				args.load >= 90 ? "busy" : args.claimsCount > 0 ? "busy" : "idle";

			// Update claim heartbeats
			for (const claim of this.claims.values()) {
				if (claim.agentId === args.agentId) {
					claim.heartbeatAt = now;
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `💓 Heartbeat received from ${args.agentId} (load: ${args.load}%, claims: ${args.claimsCount})`,
					},
				],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#2: Spawn request for new agents
	 */
	async spawnAgent(args: {
		template: string;
		model: string;
		provider: AgentProvider;
		capabilities?: string[];
		targetProposalId?: string;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const requestId = `spawn-${Date.now()}`;
			const now = new Date().toISOString();

			this.spawnRequests.set(requestId, {
				id: requestId,
				template: args.template,
				model: args.model,
				provider: args.provider,
				capabilities: args.capabilities,
				targetProposalId: args.targetProposalId,
				reason: args.reason,
				status: "pending",
				createdAt: now,
			});

			return {
				content: [
					{
						type: "text",
						text: [
							"🚀 Spawn request created",
							`Request ID: ${requestId}`,
							`Template: ${args.template}`,
							`Model: ${args.model} (${args.provider})`,
							`Reason: ${args.reason}`,
							args.targetProposalId
								? `Target Proposal: ${args.targetProposalId}`
								: "",
							"",
							"Status: Pending approval",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#2: Retire an agent from the pool
	 */
	async retireAgent(args: {
		agentId: string;
		reason: string;
		releaseClaims?: boolean;
	}): Promise<CallToolResult> {
		try {
			const agent = this.agents.get(args.agentId);
			if (!agent) {
				throw new McpError(`Agent ${args.agentId} not found`, "NOT_FOUND");
			}

			// Release claims if requested
			if (args.releaseClaims !== false) {
				for (const [id, claim] of this.claims) {
					if (claim.agentId === args.agentId) {
						this.claims.delete(id);
					}
				}
			}

			agent.status = "offline";
			agent.claimsCount = 0;
			agent.lastError = `Retired: ${args.reason}`;
			agent.updatedAt = new Date().toISOString();

			return {
				content: [
					{
						type: "text",
						text: [
							`🛑 Agent retired`,
							`ID: ${args.agentId}`,
							`Reason: ${args.reason}`,
							`Claims released: ${args.releaseClaims !== false}`,
						].join("\n"),
					},
				],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#5: Detect stale agents after an extended silence window
	 */
	async detectZombies(): Promise<CallToolResult> {
		try {
			const now = Date.now();
			const zombies: string[] = [];

			for (const [id, agent] of this.agents) {
				if (agent.status === "offline") continue;

				const lastHeartbeat = new Date(agent.heartbeatAt).getTime();
				const age = now - lastHeartbeat;

				if (age > STALE_AGENT_THRESHOLD_MS) {
					agent.status = "offline";
					agent.lastError = `Agent marked offline after ${Math.round(age / 3600000)} hours without heartbeat`;
					zombies.push(id);

					// Release claims
					for (const [claimId, claim] of this.claims) {
						if (claim.agentId === id) {
							this.claims.delete(claimId);
						}
					}
				}
			}

			return {
				content: [
					{
						type: "text",
						text:
							zombies.length > 0
								? [
										"💀 Zombie Detection Complete",
										`Found ${zombies.length} zombie agent(s):`,
										...zombies.map((z) => `  - ${z}`),
										"",
										"All zombie claims have been released.",
									].join("\n")
								: "✅ No zombie agents detected. All agents are healthy.",
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * Get pool statistics
	 */
	async getPoolStats(): Promise<CallToolResult> {
		try {
			const agents = Array.from(this.agents.values());

			const stats = {
				totalAgents: agents.length,
				byStatus: {
					online: agents.filter((a) => a.status === "online").length,
					idle: agents.filter((a) => a.status === "idle").length,
					busy: agents.filter((a) => a.status === "busy").length,
					offline: agents.filter((a) => a.status === "offline").length,
					error: agents.filter((a) => a.status === "error").length,
				},
				byProvider: {
					anthropic: agents.filter((a) => a.provider === "anthropic").length,
					openai: agents.filter((a) => a.provider === "openai").length,
					google: agents.filter((a) => a.provider === "google").length,
					local: agents.filter((a) => a.provider === "local").length,
					custom: agents.filter((a) => a.provider === "custom").length,
				},
				totalClaims: Array.from(this.claims.values()).length,
				avgTrustScore:
					agents.length > 0
						? Math.round(
								agents.reduce((sum, a) => sum + a.trustScore, 0) /
									agents.length,
							)
						: 0,
			};

			return {
				content: [
					{
						type: "text",
						text: [
							"📊 Agent Pool Statistics",
							`${"─".repeat(40)}`,
							`Total Agents: ${stats.totalAgents}`,
							`Active Claims: ${stats.totalClaims}`,
							`Average Trust Score: ${stats.avgTrustScore}/100`,
							"",
							"By Status:",
							`  🟢 Online: ${stats.byStatus.online}`,
							`  ⚪ Idle: ${stats.byStatus.idle}`,
							`  🟡 Busy: ${stats.byStatus.busy}`,
							`  ⚫ Offline: ${stats.byStatus.offline}`,
							`  🔴 Error: ${stats.byStatus.error}`,
							"",
							"By Provider:",
							`  🟣 Anthropic (Claude): ${stats.byProvider.anthropic}`,
							`  🟢 OpenAI (GPT): ${stats.byProvider.openai}`,
							`  🔵 Google (Gemini): ${stats.byProvider.google}`,
							`  🟤 Local: ${stats.byProvider.local}`,
							`  ⚪ Custom: ${stats.byProvider.custom}`,
						].join("\n"),
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private statusEmoji(status: McpAgentStatus): string {
		const map: Record<McpAgentStatus, string> = {
			active: "🟢",
			online: "🟢",
			idle: "⚪",
			busy: "🟡",
			offline: "⚫",
			error: "🔴",
		};
		return map[status] ?? "⚪";
	}

	private providerEmoji(provider: AgentProvider): string {
		const map: Partial<Record<AgentProvider, string>> = {
			anthropic: "🟣",
			openai: "🟢",
			google: "🔵",
			local: "🟤",
			custom: "⚪",
		};
		return map[provider] ?? "⚪";
	}

	private estimateCostClass(
		model: string,
		provider: AgentProvider,
	): "low" | "medium" | "high" {
		const modelLower = model.toLowerCase();

		// High cost models
		if (
			modelLower.includes("opus") ||
			modelLower.includes("gpt-4-turbo") ||
			modelLower.includes("gpt-4o")
		) {
			return "high";
		}

		// Low cost models
		if (
			provider === "local" ||
			modelLower.includes("haiku") ||
			modelLower.includes("mini") ||
			modelLower.includes("flash")
		) {
			return "low";
		}

		// Default medium
		return "medium";
	}
}

// ── S100: Reporting & Privilege ─────────────────────────────────────────
const reportingHierarchy = new Map<string, string | null>();
const grantedPrivileges = new Map<
	number,
	{ agentId: string; permission: string; grantedBy: string }
>();
let nextPrivilegeId = 1;

export async function updateReporting(args: {
	agentId: string;
	managerId?: string | null;
}) {
	const managerId = args.managerId || null;
	reportingHierarchy.set(args.agentId, managerId);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					success: true,
					agentId: args.agentId,
					reportsTo: managerId,
				}),
			},
		],
	};
}

export async function grantPrivilege(args: {
	agentId: string;
	permission: string;
	grantedBy: string;
}) {
	const privilegeId = nextPrivilegeId++;
	grantedPrivileges.set(privilegeId, { ...args });
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					success: true,
					id: privilegeId,
					agentId: args.agentId,
					permission: args.permission,
				}),
			},
		],
	};
}

export async function revokePrivilege(args: { privilegeId: number }) {
	grantedPrivileges.delete(args.privilegeId);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ success: true, revoked: args.privilegeId }),
			},
		],
	};
}
