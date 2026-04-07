/**
 * STATE-62: Dynamic Team Building - Assemble Agent Teams for Projects
 *
 * How to dynamically build teams from the agent pool based on project needs,
 * agent capabilities, and availability.
 *
 * AC#1: Team builder tool accepts project requirements (skills, roles, capacity)
 * AC#2: System queries agent registry for matching capabilities
 * AC#3: Team composition suggested with skill coverage analysis
 * AC#4: Agents can accept or decline team assignment
 * AC#5: Team lead assigned based on role expertise or availability
 * AC#6: Team communication channel created (shared group-pulse or dedicated)
 * AC#7: Team dissolution protocol when project completes
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type TeamStatus =
	| "forming"
	| "active"
	| "paused"
	| "completed"
	| "dissolved";
export type AgentTeamStatus =
	| "invited"
	| "accepted"
	| "declined"
	| "active"
	| "removed";
export type TeamRole =
	| "lead"
	| "developer"
	| "reviewer"
	| "tester"
	| "architect"
	| "coordinator"
	| string;

export interface AgentProfile {
	agentId: string;
	name: string;
	capabilities: string[]; // Skills like "typescript", "testing", "api-design"
	costClass: "low" | "medium" | "high";
	availability: "available" | "busy" | "offline";
	trustScore: number; // 0-100
	currentWorkload: number; // 0-100 percentage
	lastActive: string;
	preferredRoles: TeamRole[];
}

export interface TeamRequirement {
	role: TeamRole;
	skillRequired: string[];
	minTrustScore?: number;
	count: number;
	priority: "required" | "preferred";
}

export interface ProjectRequirements {
	projectId: string;
	projectName: string;
	description: string;
	requirements: TeamRequirement[];
	totalCapacityNeeded: number; // 0-100
	skillsCoverage: string[]; // All skills needed
	estimatedDuration?: string;
}

export interface TeamMember {
	agentId: string;
	role: TeamRole;
	assignedAt: string;
	status: AgentTeamStatus;
	respondedAt?: string;
	skillMatch: number; // 0-100 percentage
	capacityContribution: number; // 0-100
}

export interface Team {
	teamId: string;
	projectId: string;
	projectName: string;
	status: TeamStatus;
	createdAt: string;
	leadAgentId?: string;
	members: TeamMember[];
	requirements: TeamRequirement[];
	skillCoverage: SkillCoverage;
	channelId?: string; // Communication channel
	dissolvedAt?: string;
	dissolveReason?: string;
	metadata: Record<string, string>;
}

export interface SkillCoverage {
	requiredSkills: string[];
	coveredSkills: string[];
	missingSkills: string[];
	coveragePercent: number; // 0-100
}

export interface TeamSuggestion {
	suggestionId: string;
	projectId: string;
	agents: Array<{
		agentId: string;
		reason: string;
		skillMatch: number;
		roleFit: TeamRole;
		availabilityScore: number;
	}>;
	overallScore: number; // 0-100
	skillCoverage: SkillCoverage;
	estimatedFormTime: string; // How long to form
}

export interface TeamChannel {
	channelId: string;
	teamId: string;
	name: string;
	description: string;
	createdAt: string;
	members: string[]; // Agent IDs
	isActive: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const TEAM_CONFIG_DIR = ".roadmap/teams";

// ─── Dynamic Team Builder ───────────────────────────────────────────

export class DynamicTeamBuilder {
	private teams: Map<string, Team> = new Map();
	private channels: Map<string, TeamChannel> = new Map();
	private agents: Map<string, AgentProfile> = new Map();
	private configDir: string;

	constructor(configDir: string = TEAM_CONFIG_DIR) {
		this.configDir = configDir;
	}

	/**
	 * Initialize the team builder.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		await this.loadProposal();
	}

	// ─── Agent Registry ────────────────────────────────────────────

	/**
	 * Register or update an agent profile.
	 */
	registerAgent(profile: AgentProfile): void {
		this.agents.set(profile.agentId, profile);
	}

	/**
	 * Get an agent profile.
	 */
	getAgent(agentId: string): AgentProfile | null {
		return this.agents.get(agentId) ?? null;
	}

	/**
	 * Get all registered agents.
	 */
	getAllAgents(): AgentProfile[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Query agents by capabilities.
	 */
	queryAgentsByCapability(capabilities: string[]): AgentProfile[] {
		return Array.from(this.agents.values()).filter((agent) =>
			capabilities.some((cap) => agent.capabilities.includes(cap)),
		);
	}

	/**
	 * Get available agents (not busy or offline).
	 */
	getAvailableAgents(): AgentProfile[] {
		return Array.from(this.agents.values()).filter(
			(agent) =>
				agent.availability === "available" && agent.currentWorkload < 80,
		);
	}

	// ─── AC#1: Team Requirements ───────────────────────────────────

	/**
	 * Build a team suggestion based on project requirements.
	 */
	suggestTeam(requirements: ProjectRequirements): TeamSuggestion {
		const availableAgents = this.getAvailableAgents();
		const selectedAgents: TeamSuggestion["agents"] = [];
		const usedAgentIds = new Set<string>();

		// For each requirement, find best matching agents
		for (const req of requirements.requirements) {
			const matches = this.findAgentsForRequirement(
				req,
				availableAgents,
				usedAgentIds,
			);
			for (const match of matches) {
				selectedAgents.push(match);
				usedAgentIds.add(match.agentId);
			}
		}

		// Calculate overall skill coverage
		const skillCoverage = this.calculateSkillCoverage(
			requirements.skillsCoverage,
			selectedAgents.flatMap((a) => {
				const agent = this.agents.get(a.agentId);
				return agent?.capabilities || [];
			}),
		);

		// Calculate overall score
		const overallScore = this.calculateOverallScore(
			selectedAgents,
			skillCoverage,
		);

		return {
			suggestionId: `SUGG-${randomUUID().slice(0, 8)}`,
			projectId: requirements.projectId,
			agents: selectedAgents,
			overallScore,
			skillCoverage,
			estimatedFormTime:
				selectedAgents.length > 0 ? "1-2 hours" : "Unable to form",
		};
	}

	/**
	 * AC#2: Find agents matching a requirement.
	 */
	private findAgentsForRequirement(
		req: TeamRequirement,
		availableAgents: AgentProfile[],
		excludedIds: Set<string>,
	): TeamSuggestion["agents"] {
		const scored = availableAgents
			.filter((agent) => !excludedIds.has(agent.agentId))
			.map((agent) => {
				const skillMatch = this.calculateSkillMatch(agent, req.skillRequired);
				const roleFit = this.calculateRoleFit(agent, req.role);
				const availabilityScore = this.calculateAvailabilityScore(agent);

				return {
					agentId: agent.agentId,
					reason: `Skills: ${req.skillRequired.join(", ")} | Role: ${req.role}`,
					skillMatch: skillMatch * 100,
					roleFit: req.role,
					availabilityScore,
					combinedScore:
						skillMatch * 0.5 + roleFit * 0.3 + availabilityScore * 0.2,
				};
			})
			.sort((a, b) => b.combinedScore - a.combinedScore)
			.slice(0, req.count);

		return scored.map(({ combinedScore, ...rest }) => rest);
	}

	/**
	 * Calculate how well an agent's skills match required skills.
	 */
	private calculateSkillMatch(
		agent: AgentProfile,
		requiredSkills: string[],
	): number {
		if (requiredSkills.length === 0) return 1;

		const matched = requiredSkills.filter((skill) =>
			agent.capabilities.some(
				(cap) =>
					cap.toLowerCase().includes(skill.toLowerCase()) ||
					skill.toLowerCase().includes(cap.toLowerCase()),
			),
		);

		return matched.length / requiredSkills.length;
	}

	/**
	 * Calculate how well an agent fits a role.
	 */
	private calculateRoleFit(agent: AgentProfile, role: TeamRole): number {
		if (agent.preferredRoles.includes(role)) return 1;
		return 0.5; // Neutral if not preferred
	}

	/**
	 * Calculate availability score based on workload.
	 */
	private calculateAvailabilityScore(agent: AgentProfile): number {
		if (agent.availability === "offline") return 0;
		if (agent.availability === "busy") return 0.3;
		return 1 - agent.currentWorkload / 100;
	}

	/**
	 * AC#3: Calculate skill coverage for a team.
	 */
	calculateSkillCoverage(
		requiredSkills: string[],
		agentSkills: string[],
	): SkillCoverage {
		const normalizedRequired = new Set(
			requiredSkills.map((s) => s.toLowerCase()),
		);
		const normalizedCovered = new Set(
			agentSkills.filter((s) => normalizedRequired.has(s.toLowerCase())),
		);

		const missing = Array.from(normalizedRequired).filter(
			(s) => !normalizedCovered.has(s.toLowerCase()),
		);

		const coveragePercent =
			normalizedRequired.size > 0
				? Math.round((normalizedCovered.size / normalizedRequired.size) * 100)
				: 100;

		return {
			requiredSkills: Array.from(normalizedRequired),
			coveredSkills: Array.from(normalizedCovered),
			missingSkills: missing,
			coveragePercent,
		};
	}

	/**
	 * Calculate overall score for a team suggestion.
	 */
	private calculateOverallScore(
		agents: TeamSuggestion["agents"],
		coverage: SkillCoverage,
	): number {
		if (agents.length === 0) return 0;

		const avgSkillMatch =
			agents.reduce((sum, a) => sum + a.skillMatch, 0) / agents.length;
		const avgAvailability =
			agents.reduce((sum, a) => sum + a.availabilityScore, 0) / agents.length;

		return Math.round(
			avgSkillMatch * 0.4 +
				coverage.coveragePercent * 0.4 +
				avgAvailability * 0.2,
		);
	}

	// ─── Team Creation ─────────────────────────────────────────────

	/**
	 * Create a team from a suggestion.
	 */
	createTeam(
		requirements: ProjectRequirements,
		suggestion: TeamSuggestion,
	): Team {
		const team: Team = {
			teamId: `TEAM-${randomUUID().slice(0, 8)}`,
			projectId: requirements.projectId,
			projectName: requirements.projectName,
			status: "forming",
			createdAt: new Date().toISOString(),
			members: suggestion.agents.map((a) => ({
				agentId: a.agentId,
				role: a.roleFit,
				assignedAt: new Date().toISOString(),
				status: "invited",
				skillMatch: a.skillMatch,
				capacityContribution: Math.round(100 / suggestion.agents.length),
			})),
			requirements: requirements.requirements,
			skillCoverage: suggestion.skillCoverage,
			metadata: {
				description: requirements.description,
				estimatedDuration: requirements.estimatedDuration || "unknown",
			},
		};

		this.teams.set(team.teamId, team);
		return team;
	}

	/**
	 * AC#5: Assign team lead based on expertise or availability.
	 */
	assignTeamLead(teamId: string, agentId: string): Team {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		const member = team.members.find((m) => m.agentId === agentId);
		if (!member) {
			throw new Error(`Agent ${agentId} is not a team member`);
		}

		team.leadAgentId = agentId;
		member.role = "lead";

		return team;
	}

	/**
	 * AC#5: Auto-select team lead based on criteria.
	 */
	autoSelectTeamLead(teamId: string): Team {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		// Score candidates based on: trust score, skill match, availability
		const candidates = team.members
			.map((member) => {
				const agent = this.agents.get(member.agentId);
				if (!agent) return null;

				return {
					member,
					agent,
					score:
						agent.trustScore * 0.4 +
						member.skillMatch * 0.4 +
						this.calculateAvailabilityScore(agent) * 20,
				};
			})
			.filter((c): c is NonNullable<typeof c> => c !== null)
			.sort((a, b) => b.score - a.score);

		if (candidates.length === 0) {
			throw new Error("No valid candidates for team lead");
		}

		return this.assignTeamLead(teamId, candidates[0].member.agentId);
	}

	// ─── AC#4: Agent Accept/Decline ────────────────────────────────

	/**
	 * Agent accepts team invitation.
	 */
	acceptInvitation(teamId: string, agentId: string): TeamMember {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		const member = team.members.find((m) => m.agentId === agentId);
		if (!member) {
			throw new Error(`Agent ${agentId} is not invited to this team`);
		}

		if (member.status !== "invited") {
			throw new Error(`Cannot accept invitation in status: ${member.status}`);
		}

		member.status = "accepted";
		member.respondedAt = new Date().toISOString();

		// Check if all members have responded
		this.checkTeamFormation(team);

		return member;
	}

	/**
	 * Agent declines team invitation.
	 */
	declineInvitation(
		teamId: string,
		agentId: string,
		_reason?: string,
	): TeamMember {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		const member = team.members.find((m) => m.agentId === agentId);
		if (!member) {
			throw new Error(`Agent ${agentId} is not invited to this team`);
		}

		member.status = "declined";
		member.respondedAt = new Date().toISOString();

		return member;
	}

	/**
	 * Check if team is fully formed.
	 */
	private checkTeamFormation(team: Team): void {
		const allAccepted = team.members.every((m) => m.status === "accepted");
		const hasRequired = team.requirements
			.filter((r) => r.priority === "required")
			.every((req) => {
				const count = team.members.filter(
					(m) => m.status === "accepted" && m.role === req.role,
				).length;
				return count >= req.count;
			});

		if (allAccepted && hasRequired) {
			team.status = "active";
		}
	}

	// ─── AC#6: Communication Channel ───────────────────────────────

	/**
	 * Create a communication channel for a team.
	 */
	createTeamChannel(teamId: string): TeamChannel {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		if (team.channelId) {
			throw new Error(`Team already has a channel: ${team.channelId}`);
		}

		const channel: TeamChannel = {
			channelId: `CHAN-${randomUUID().slice(0, 8)}`,
			teamId,
			name: `team-${team.projectName.toLowerCase().replace(/\s+/g, "-")}`,
			description: `Communication channel for team working on ${team.projectName}`,
			createdAt: new Date().toISOString(),
			members: team.members.map((m) => m.agentId),
			isActive: true,
		};

		this.channels.set(channel.channelId, channel);
		team.channelId = channel.channelId;

		return channel;
	}

	/**
	 * Get a team's communication channel.
	 */
	getTeamChannel(teamId: string): TeamChannel | null {
		const team = this.teams.get(teamId);
		if (!team || !team.channelId) return null;
		return this.channels.get(team.channelId) ?? null;
	}

	// ─── AC#7: Team Dissolution ────────────────────────────────────

	/**
	 * Dissolve a team when project completes.
	 */
	dissolveTeam(teamId: string, reason: string): Team {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		team.status = "dissolved";
		team.dissolvedAt = new Date().toISOString();
		team.dissolveReason = reason;

		// Mark members as removed
		for (const member of team.members) {
			if (member.status === "accepted" || member.status === "active") {
				member.status = "removed";
			}
		}

		// Deactivate channel
		if (team.channelId) {
			const channel = this.channels.get(team.channelId);
			if (channel) {
				channel.isActive = false;
			}
		}

		return team;
	}

	/**
	 * Mark team as completed (successful project finish).
	 */
	completeTeam(teamId: string): Team {
		const team = this.teams.get(teamId);
		if (!team) {
			throw new Error(`Team not found: ${teamId}`);
		}

		team.status = "completed";
		team.dissolvedAt = new Date().toISOString();
		team.dissolveReason = "Project completed";

		// Deactivate channel
		if (team.channelId) {
			const channel = this.channels.get(team.channelId);
			if (channel) {
				channel.isActive = false;
			}
		}

		return team;
	}

	// ─── Query Methods ─────────────────────────────────────────────

	/**
	 * Get a team by ID.
	 */
	getTeam(teamId: string): Team | null {
		return this.teams.get(teamId) ?? null;
	}

	/**
	 * Get teams by status.
	 */
	getTeamsByStatus(status: TeamStatus): Team[] {
		return Array.from(this.teams.values()).filter((t) => t.status === status);
	}

	/**
	 * Get teams an agent belongs to.
	 */
	getAgentTeams(agentId: string): Team[] {
		return Array.from(this.teams.values()).filter((t) =>
			t.members.some((m) => m.agentId === agentId),
		);
	}

	/**
	 * Get all teams.
	 */
	getAllTeams(): Team[] {
		return Array.from(this.teams.values());
	}

	/**
	 * Get team roster.
	 */
	getTeamRoster(teamId: string): TeamMember[] | null {
		const team = this.teams.get(teamId);
		return team?.members ?? null;
	}

	/**
	 * Get team statistics.
	 */
	getStats(): {
		totalTeams: number;
		forming: number;
		active: number;
		completed: number;
		dissolved: number;
		totalChannels: number;
		activeChannels: number;
	} {
		const teams = Array.from(this.teams.values());
		const channels = Array.from(this.channels.values());

		return {
			totalTeams: teams.length,
			forming: teams.filter((t) => t.status === "forming").length,
			active: teams.filter((t) => t.status === "active").length,
			completed: teams.filter((t) => t.status === "completed").length,
			dissolved: teams.filter((t) => t.status === "dissolved").length,
			totalChannels: channels.length,
			activeChannels: channels.filter((c) => c.isActive).length,
		};
	}

	// ─── Persistence ───────────────────────────────────────────────

	/**
	 * Save proposal to disk.
	 */
	async saveProposal(): Promise<void> {
		const proposal = {
			teams: Array.from(this.teams.entries()),
			channels: Array.from(this.channels.entries()),
			agents: Array.from(this.agents.entries()),
		};

		const proposalPath = join(this.configDir, "proposal.json");
		await writeFile(proposalPath, JSON.stringify(proposal, null, 2));
	}

	/**
	 * Load proposal from disk.
	 */
	async loadProposal(): Promise<void> {
		const proposalPath = join(this.configDir, "proposal.json");
		try {
			await access(proposalPath);
			const content = await readFile(proposalPath, "utf-8");
			const proposal = JSON.parse(content);

			this.teams = new Map(proposal.teams || []);
			this.channels = new Map(proposal.channels || []);
			this.agents = new Map(proposal.agents || []);
		} catch {
			// No proposal yet
		}
	}
}

// ─── Convenience Functions ──────────────────────────────────────────

/**
 * Create a simple project requirement.
 */
export function createRequirement(
	role: TeamRole,
	skills: string[],
	count: number = 1,
	priority: "required" | "preferred" = "required",
): TeamRequirement {
	return {
		role,
		skillRequired: skills,
		count,
		priority,
	};
}

/**
 * Create a simple agent profile.
 */
export function createAgentProfile(
	agentId: string,
	name: string,
	capabilities: string[],
	options?: {
		availability?: "available" | "busy" | "offline";
		costClass?: "low" | "medium" | "high";
		trustScore?: number;
		currentWorkload?: number;
		preferredRoles?: TeamRole[];
	},
): AgentProfile {
	return {
		agentId,
		name,
		capabilities,
		costClass: options?.costClass || "medium",
		availability: options?.availability || "available",
		trustScore: options?.trustScore ?? 75,
		currentWorkload: options?.currentWorkload ?? 0,
		lastActive: new Date().toISOString(),
		preferredRoles: options?.preferredRoles || [],
	};
}

/**
 * Calculate simple skill match score.
 */
export function calculateSimpleSkillMatch(
	agentSkills: string[],
	requiredSkills: string[],
): number {
	if (requiredSkills.length === 0) return 1;

	const matched = requiredSkills.filter((req) =>
		agentSkills.some((skill) => skill.toLowerCase() === req.toLowerCase()),
	);

	return matched.length / requiredSkills.length;
}
