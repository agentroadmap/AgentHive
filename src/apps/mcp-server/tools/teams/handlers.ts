/**
 * MCP tool handlers for team operations
 *
 * STATE-62: Dynamic Team Building
 * STATE-63: Agent Team Membership
 * STATE-61: Agent Proposal & Lease-Based Backlog System
 * STATE-46: Multi-Host Federation
 */

import {
	createHeartbeatProof,
	ProposalLeaseManager,
} from "../../../../core/collaboration/proposal-lease.ts";
import {
	createRequirement,
	DynamicTeamBuilder,
} from "../../../../core/collaboration/team-builder.ts";
import { AgentTeamMembership } from "../../../../core/collaboration/team-membership.ts";
import type { FederationServer } from "../../../../core/infrastructure/federation-server.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export class TeamHandlers {
	private teamBuilder: DynamicTeamBuilder;
	private membership: AgentTeamMembership;
	private proposalManager: ProposalLeaseManager;
	private federation: FederationServer | null = null;

	constructor(private readonly server: McpServer) {
		this.teamBuilder = new DynamicTeamBuilder();
		this.membership = new AgentTeamMembership();
		this.proposalManager = new ProposalLeaseManager();
	}

	/**
	 * Initialize async components.
	 */
	async initialize(): Promise<void> {
		await this.teamBuilder.initialize();
		await this.membership.initialize();
		await this.proposalManager.initialize();
	}

	/**
	 * Set federation server instance.
	 */
	setFederation(federation: FederationServer): void {
		this.federation = federation;
	}

	// ─── Team Operations (STATE-62) ────────────────────────────────

	/**
	 * AC#1: Create a team suggestion based on requirements.
	 */
	async createTeam(args: {
		projectName: string;
		description: string;
		requirements: Array<{
			role: string;
			skills: string[];
			count?: number;
			priority?: string;
		}>;
		skills: string[];
	}): Promise<CallToolResult> {
		try {
			const requirements = args.requirements.map((r) =>
				createRequirement(
					r.role,
					r.skills,
					r.count || 1,
					(r.priority as "required" | "preferred") || "required",
				),
			);

			const projectReq = {
				projectId: `PROJ-${Date.now()}`,
				projectName: args.projectName,
				description: args.description,
				requirements,
				totalCapacityNeeded: 100,
				skillsCoverage: args.skills,
			};

			const suggestion = this.teamBuilder.suggestTeam(projectReq);
			const team = this.teamBuilder.createTeam(projectReq, suggestion);

			// Auto-select team lead
			if (team.members.length > 0) {
				this.teamBuilder.autoSelectTeamLead(team.teamId);
			}

			const updatedTeam = this.teamBuilder.getTeam(team.teamId);

			return {
				content: [
					{
						type: "text",
						text:
							`Team created: ${updatedTeam?.teamId}\n` +
							`Project: ${args.projectName}\n` +
							`Members: ${updatedTeam?.members.length || 0}\n` +
							`Lead: ${updatedTeam?.leadAgentId || "none"}\n` +
							`Skill Coverage: ${suggestion.skillCoverage.coveragePercent}%\n` +
							`Overall Score: ${suggestion.overallScore}`,
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
	 * AC#4: Agent accepts team invitation.
	 */
	async acceptInvitation(args: {
		teamId: string;
		agentId: string;
	}): Promise<CallToolResult> {
		try {
			const member = this.teamBuilder.acceptInvitation(
				args.teamId,
				args.agentId,
			);

			return {
				content: [
					{
						type: "text",
						text:
							`Agent ${args.agentId} accepted invitation to team ${args.teamId}\n` +
							`Role: ${member.role}\n` +
							`Status: ${member.status}`,
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
	 * AC#4: Agent declines team invitation.
	 */
	async declineInvitation(args: {
		teamId: string;
		agentId: string;
		reason?: string;
	}): Promise<CallToolResult> {
		try {
			const member = this.teamBuilder.declineInvitation(
				args.teamId,
				args.agentId,
				args.reason,
			);

			return {
				content: [
					{
						type: "text",
						text:
							`Agent ${args.agentId} declined invitation to team ${args.teamId}\n` +
							`Reason: ${args.reason || "No reason provided"}\n` +
							`Status: ${member.status}`,
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
	 * AC#7: Dissolve a team.
	 */
	async dissolveTeam(args: {
		teamId: string;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const team = this.teamBuilder.dissolveTeam(args.teamId, args.reason);

			return {
				content: [
					{
						type: "text",
						text:
							`Team ${args.teamId} dissolved\n` +
							`Reason: ${args.reason}\n` +
							`Status: ${team.status}`,
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
	 * AC#7: Query team roster.
	 */
	async queryRoster(args: {
		teamId?: string;
		role?: string;
		pool?: string;
	}): Promise<CallToolResult> {
		try {
			const entries = this.membership.queryRoster(args);

			if (entries.length === 0) {
				return {
					content: [
						{ type: "text", text: "No team members found matching criteria." },
					],
				};
			}

			const lines = [`Team Roster (${entries.length} members):`];
			for (const entry of entries) {
				lines.push(
					`- ${entry.agentId} | Role: ${entry.role} | Pool: ${entry.pool}`,
				);
				lines.push(`  Skills: ${entry.skills.join(", ")}`);
				lines.push(`  Status: ${entry.status}`);
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
	 * P055: List all teams with optional filtering.
	 */
	async listTeams(args: {
		status?: "active" | "archived" | "all";
		teamType?: string;
	}): Promise<CallToolResult> {
		try {
			const teams = this.teamBuilder.getAllTeams().filter((team) => {
				const status = args.status ?? "active";
				const matchesStatus = status === "all" || team.status === status;
				const matchesType =
					!args.teamType || team.metadata.teamType === args.teamType;
				return matchesStatus && matchesType;
			});

			if (teams.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No teams found matching criteria.\n\nUse team_create to create a new team.",
						},
					],
				};
			}

			const lines = [`Teams (${teams.length}):`, ""];

			for (const team of teams) {
				lines.push(`📋 ${team.projectName || team.teamId}`);
				lines.push(`   ID: ${team.teamId}`);
				lines.push(`   Type: ${team.metadata.teamType || "general"}`);
				lines.push(`   Status: ${team.status}`);
				lines.push(`   Members: ${team.members.length}`);
				if (team.metadata.description) {
					lines.push(`   Description: ${team.metadata.description}`);
				}
				lines.push("");
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
	 * P055: Add a member to a team.
	 */
	async addTeamMember(args: {
		teamId: string;
		agentId: string;
		role: string;
	}): Promise<CallToolResult> {
		try {
			this.membership.addToRoster(args.teamId, args.agentId);

			return {
				content: [
					{
						type: "text",
						text:
							`Agent ${args.agentId} added to team ${args.teamId}\n` +
							`Role: ${args.role}\n` +
							`Status: active`,
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

	// ─── Membership Operations (STATE-63) ──────────────────────────

	/**
	 * AC#1: Register an agent for team membership.
	 */
	async registerAgent(args: {
		agentId: string;
		skills: string[];
		role: string;
		pool: string;
	}): Promise<CallToolResult> {
		try {
			const registration = await this.membership.registerAgent({
				agentId: args.agentId,
				skills: args.skills,
				roleAssignment: args.role,
				poolAssignment: args.pool,
			});

			// Auto-activate for convenience
			await this.membership.activateRegistration(registration.registrationId);

			return {
				content: [
					{
						type: "text",
						text:
							`Agent ${args.agentId} registered successfully\n` +
							`Registration ID: ${registration.registrationId}\n` +
							`Role: ${args.role}\n` +
							`Pool: ${args.pool}\n` +
							`Status: active`,
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

	// ─── Proposal Operations (STATE-61) ────────────────────────────

	/**
	 * AC#1: Submit a proposal.
	 */
	async submitProposal(args: {
		proposalId: string;
		title: string;
		description: string;
		proposedBy: string;
		tags?: string[];
		priority?: string;
	}): Promise<CallToolResult> {
		try {
			const proposal = this.proposalManager.submitProposal({
				proposalId: args.proposalId,
				title: args.title,
				description: args.description,
				proposedBy: args.proposedBy,
				tags: args.tags,
				priority: args.priority as "low" | "medium" | "high" | "critical",
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Proposal submitted: ${proposal.proposalId}\n` +
							`Proposal: ${args.proposalId}\n` +
							`Title: ${args.title}\n` +
							`Status: ${proposal.status}`,
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
	 * AC#2: Submit a review for a proposal.
	 */
	async reviewProposal(args: {
		proposalId: string;
		reviewerId: string;
		role: string;
		recommendation: string;
		score: number;
		comments: string;
	}): Promise<CallToolResult> {
		try {
			const review = this.proposalManager.submitReview({
				proposalId: args.proposalId,
				reviewerId: args.reviewerId,
				reviewerRole: args.role as "pm" | "architect" | "lead" | "peer",
				recommendation: args.recommendation as
					| "approve"
					| "reject"
					| "needs-revision",
				score: args.score,
				comments: args.comments,
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Review submitted: ${review.reviewId}\n` +
							`Proposal: ${args.proposalId}\n` +
							`Recommendation: ${args.recommendation}\n` +
							`Score: ${args.score}/10`,
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

	// ─── Lease Operations (STATE-61) ───────────────────────────────

	/**
	 * AC#4: Acquire a lease on a backlog item.
	 */
	async acquireLease(args: {
		itemId: string;
		agentId: string;
		durationHours?: number;
	}): Promise<CallToolResult> {
		try {
			const durationMs = (args.durationHours || 48) * 60 * 60 * 1000;
			const lease = this.proposalManager.leaseItem(args.itemId, args.agentId, {
				durationMs,
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Lease acquired: ${lease.leaseId}\n` +
							`Item: ${args.itemId}\n` +
							`Agent: ${args.agentId}\n` +
							`Expires: ${lease.expiresAt}\n` +
							`Renewals: ${lease.renewalCount}/${lease.maxRenewals}`,
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
	 * AC#6: Renew a lease using heartbeat.
	 */
	async renewLease(args: {
		leaseId: string;
		agentId: string;
	}): Promise<CallToolResult> {
		try {
			const proof = createHeartbeatProof(args.leaseId, args.agentId);
			const lease = this.proposalManager.renewLease(proof);

			return {
				content: [
					{
						type: "text",
						text:
							`Lease renewed: ${lease.leaseId}\n` +
							`New expiry: ${lease.expiresAt}\n` +
							`Renewals: ${lease.renewalCount}/${lease.maxRenewals}`,
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

	// ─── Federation Operations (STATE-46) ──────────────────────────

	/**
	 * Get federation status.
	 */
	async getFederationStatus(): Promise<CallToolResult> {
		try {
			if (!this.federation) {
				return {
					content: [
						{ type: "text", text: "Federation server not initialized." },
					],
				};
			}

			const status = this.federation.getStats();

			const stats = status as any;
			return {
				content: [
					{
						type: "text",
						text:
							`Federation Status:\n` +
							`Host ID: ${stats.hostId}\n` +
							`Port: ${stats.port}\n` +
							`Connected Agents: ${stats.connectedAgents}\n` +
							`Pending Changes: ${stats.pendingChanges}\n` +
							`Pending Conflicts: ${stats.conflicts}\n` +
							`Connections: ${stats.connectionStats?.alive}/${stats.connectionStats?.total} alive`,
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
}
