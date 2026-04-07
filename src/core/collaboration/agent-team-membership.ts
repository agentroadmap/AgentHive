/**
 * STATE-63: Agent Team Membership
 *
 * Manages how agents discover, join, and leave teams across the multi-agent
 * federation. Provides a registry of team memberships that agents can query
 * to understand their workload and team affiliations.
 *
 * AC#1: Agents can discover teams for a given proposal
 * AC#2: Agents can join teams (with capacity management)
 * AC#3: Team membership status tracked (active/inactive/retired)
 * AC#4: Agents can query their team memberships across all proposals
 */

import type { Team, TeamRole } from "./dynamic-team-builder.ts";

// ─── Types ───────────────────────────────────────────────────────────────

/** Agent's membership status in a team */
export type MembershipStatus =
	| "active" // Currently participating
	| "inactive" // Temporarily not participating
	| "retired" // Left or removed
	| "pending"; // Waiting to join

/** Agent's availability status */
export type AgentAvailability =
	| "available" // Can take new work
	| "busy" // At capacity
	| "unavailable" // Offline or out of office
	| "degraded"; // Reduced capacity

/** Team discovery result */
export interface TeamDiscovery {
	/** Team found */
	team: Team;
	/** Relevance score (0-1) based on agent skills and team needs */
	relevance: number;
	/** Available roles in the team */
	availableRoles: TeamRole[];
	/** Current capacity utilization (0-1) */
	capacityUtilization: number;
	/** Why this team was suggested */
	reason: string;
}

/** Agent membership record */
export interface AgentMembership {
	/** Unique membership ID */
	membershipId: string;
	/** Agent identifier */
	agentId: string;
	/** Team identifier */
	teamId: string;
	/** Proposal the team is working on */
	proposalId: string;
	/** Current role in the team */
	role: TeamRole;
	/** Membership status */
	status: MembershipStatus;
	/** When the agent joined */
	joinedAt: string;
	/** When status last changed */
	lastStatusChange: string;
	/** Capacity allocated to this team (0-100%) */
	capacity: number;
	/** Last time agent was active in this team */
	lastActivity?: string;
	/** Contribution metrics */
	contributions: ContributionMetrics;
	/** When agent left (if retired) */
	leftAt?: string;
	/** Reason for leaving */
	leaveReason?: string;
}

/** Contribution metrics for an agent in a team */
export interface ContributionMetrics {
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of reviews provided */
	reviewsProvided: number;
	/** Number of comments/discussions */
	discussions: number;
	/** Number of merge/PR contributions */
	commits: number;
	/** Last updated timestamp */
	lastUpdated: string;
}

/** Agent profile for team matching */
export interface AgentProfile {
	/** Agent identifier */
	agentId: string;
	/** Agent name/alias */
	displayName: string;
	/** Skills/capabilities */
	skills: string[];
	/** Current total capacity usage (0-100) */
	usedCapacity: number;
	/** Maximum capacity (usually 100) */
	maxCapacity: number;
	/** Availability status */
	availability: AgentAvailability;
	/** Teams currently active in */
	activeTeamCount: number;
	/** Average contribution score (0-1) */
	avgContribution: number;
	/** Last seen timestamp */
	lastSeen: string;
}

/** Team membership query filter */
export interface MembershipFilter {
	agentId?: string;
	teamId?: string;
	proposalId?: string;
	status?: MembershipStatus;
	role?: TeamRole;
}

/** Team composition report */
export interface TeamComposition {
	teamId: string;
	proposalId: string;
	/** Active members */
	activeCount: number;
	/** Total members including inactive */
	totalCount: number;
	/** Roles breakdown */
	roles: Record<TeamRole, number>;
	/** Average capacity utilization */
	avgCapacity: number;
	/** Missing roles */
	missingRoles: TeamRole[];
	/** Capacity available (0-100) */
	capacityAvailable: number;
}

/** Membership event for history */
export interface MembershipEvent {
	eventId: string;
	agentId: string;
	teamId: string;
	event:
		| "joined"
		| "left"
		| "status-changed"
		| "role-changed"
		| "capacity-changed";
	timestamp: string;
	metadata?: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_MAX_TEAMS_PER_AGENT = 10;
const DEFAULT_CAPACITY_PER_TEAM = 25; // 4 teams = 100%
const _ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─── Agent Team Membership Manager ──────────────────────────────────────

/**
 * Manages agent team memberships across the federation.
 */
export class AgentTeamMembership {
	private memberships: Map<string, AgentMembership> = new Map();
	private agents: Map<string, AgentProfile> = new Map();
	private teams: Map<string, Team> = new Map();
	private events: MembershipEvent[] = [];
	private maxTeamsPerAgent: number;

	constructor(options?: { maxTeamsPerAgent?: number }) {
		this.maxTeamsPerAgent =
			options?.maxTeamsPerAgent ?? DEFAULT_MAX_TEAMS_PER_AGENT;
	}

	// ─── AC#1: Discover Teams for a Given Proposal ────────────────────

	/**
	 * Discover available teams for a given proposal.
	 */
	discoverTeams(
		agentId: string,
		proposalId: string,
		options?: {
			skills?: string[];
			minRelevance?: number;
			includeFullTeams?: boolean;
		},
	): TeamDiscovery[] {
		const agent = this.agents.get(agentId);
		const discoveries: TeamDiscovery[] = [];

		for (const team of this.teams.values()) {
			if (team.proposalId !== proposalId) continue;
			if (!options?.includeFullTeams && team.capacity >= 100) continue;

			// Calculate relevance based on agent skills vs team needs
			const relevance = this.calculateRelevance(agent, team, options?.skills);

			// Find available roles
			const availableRoles = this.getAvailableRoles(team);

			// Calculate capacity utilization
			const capacityUtilization = team.capacity / 100;

			// Determine reason for suggestion
			const reason = this.determineSuggestionReason(
				agent,
				team,
				relevance,
				availableRoles,
			);

			discoveries.push({
				team,
				relevance,
				availableRoles,
				capacityUtilization,
				reason,
			});
		}

		// Sort by relevance
		discoveries.sort((a, b) => b.relevance - a.relevance);

		// Filter by minimum relevance if specified
		if (options?.minRelevance) {
			return discoveries.filter((d) => d.relevance >= options.minRelevance!);
		}

		return discoveries;
	}

	/**
	 * Register a team for discovery.
	 */
	registerTeam(team: Team): void {
		this.teams.set(team.teamId, team);
	}

	/**
	 * Update a registered team.
	 */
	updateTeam(team: Team): void {
		this.teams.set(team.teamId, team);
	}

	/**
	 * Unregister a team.
	 */
	unregisterTeam(teamId: string): void {
		this.teams.delete(teamId);
	}

	/**
	 * Get all registered teams.
	 */
	getRegisteredTeams(): Team[] {
		return Array.from(this.teams.values());
	}

	// ─── AC#2: Agents Can Join Teams (Capacity Management) ─────────

	/**
	 * Register an agent profile for team matching.
	 */
	registerAgent(profile: AgentProfile): void {
		this.agents.set(profile.agentId, profile);
	}

	/**
	 * Update an agent profile.
	 */
	updateAgent(profile: AgentProfile): void {
		this.agents.set(profile.agentId, profile);
	}

	/**
	 * Join a team.
	 */
	joinTeam(
		agentId: string,
		teamId: string,
		options?: {
			role?: TeamRole;
			capacity?: number;
		},
	): AgentMembership {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		// Check if already a member
		const existing = this.getMembership(agentId, teamId);
		if (existing && existing.status !== "retired") {
			throw new Error(
				`${agentId} is already a member of team ${teamId} with status ${existing.status}`,
			);
		}

		// Check capacity
		const capacity = options?.capacity ?? DEFAULT_CAPACITY_PER_TEAM;
		const agent = this.agents.get(agentId);
		if (agent) {
			const availableCapacity = agent.maxCapacity - agent.usedCapacity;
			if (capacity > availableCapacity) {
				throw new Error(
					`Insufficient capacity: requested ${capacity}, available ${availableCapacity}`,
				);
			}
		}

		// Check max teams
		const activeTeams = this.getAgentMemberships(agentId).filter(
			(m) => m.status === "active",
		);
		if (activeTeams.length >= this.maxTeamsPerAgent) {
			throw new Error(
				`${agentId} has reached max team limit (${this.maxTeamsPerAgent})`,
			);
		}

		// Determine role
		const role = options?.role ?? this.determineRole(team, agentId);

		const now = new Date().toISOString();
		const membership: AgentMembership = {
			membershipId: generateId("MEM"),
			agentId,
			teamId,
			proposalId: team.proposalId,
			role,
			status: "active",
			joinedAt: now,
			lastStatusChange: now,
			capacity,
			contributions: {
				tasksCompleted: 0,
				reviewsProvided: 0,
				discussions: 0,
				commits: 0,
				lastUpdated: now,
			},
		};

		this.memberships.set(membership.membershipId, membership);

		// Update agent's used capacity
		if (agent) {
			agent.usedCapacity += capacity;
			agent.activeTeamCount++;
		}

		// Record event
		this.recordEvent(agentId, teamId, "joined", { role, capacity });

		return membership;
	}

	/**
	 * Leave a team.
	 */
	leaveTeam(agentId: string, teamId: string, reason?: string): AgentMembership {
		// Find any membership including retired ones
		const membership = this.findMembershipIncludingRetired(agentId, teamId);
		if (!membership)
			throw new Error(`${agentId} is not a member of team ${teamId}`);
		if (membership.status === "retired")
			throw new Error(`${agentId} has already left team ${teamId}`);

		membership.status = "retired";
		membership.lastStatusChange = new Date().toISOString();
		membership.leftAt = membership.lastStatusChange;
		membership.leaveReason = reason;

		// Update agent's used capacity
		const agent = this.agents.get(agentId);
		if (agent) {
			agent.usedCapacity = Math.max(
				0,
				agent.usedCapacity - membership.capacity,
			);
			agent.activeTeamCount = Math.max(0, agent.activeTeamCount - 1);
		}

		this.recordEvent(agentId, teamId, "left", { reason });

		return membership;
	}

	/**
	 * Temporarily set membership to inactive.
	 */
	setInactive(agentId: string, teamId: string): AgentMembership {
		const membership = this.findMembership(agentId, teamId);
		if (!membership) {
			// Check if the agent has left (retired) the team
			const retired = this.findMembershipIncludingRetired(agentId, teamId);
			if (retired)
				throw new Error(
					`Cannot set inactive: ${agentId} has left team ${teamId}`,
				);
			throw new Error(`${agentId} is not a member of team ${teamId}`);
		}
		if (membership.status !== "active")
			throw new Error(
				`Cannot set inactive: current status is ${membership.status}`,
			);

		membership.status = "inactive";
		membership.lastStatusChange = new Date().toISOString();

		// Free up capacity temporarily
		const agent = this.agents.get(agentId);
		if (agent) {
			agent.usedCapacity = Math.max(
				0,
				agent.usedCapacity - membership.capacity,
			);
			agent.activeTeamCount = Math.max(0, agent.activeTeamCount - 1);
		}

		this.recordEvent(agentId, teamId, "status-changed", {
			from: "active",
			to: "inactive",
		});

		return membership;
	}

	/**
	 * Reactivate an inactive membership.
	 */
	setActive(agentId: string, teamId: string): AgentMembership {
		const membership = this.findMembership(agentId, teamId);
		if (!membership)
			throw new Error(`${agentId} is not a member of team ${teamId}`);
		if (membership.status !== "inactive")
			throw new Error(
				`Cannot set active: current status is ${membership.status}`,
			);

		// Check capacity
		const agent = this.agents.get(agentId);
		if (agent) {
			const availableCapacity = agent.maxCapacity - agent.usedCapacity;
			if (membership.capacity > availableCapacity) {
				throw new Error(
					`Insufficient capacity to reactivate: need ${membership.capacity}, available ${availableCapacity}`,
				);
			}
			agent.usedCapacity += membership.capacity;
			agent.activeTeamCount++;
		}

		membership.status = "active";
		membership.lastStatusChange = new Date().toISOString();

		this.recordEvent(agentId, teamId, "status-changed", {
			from: "inactive",
			to: "active",
		});

		return membership;
	}

	/**
	 * Update the capacity allocated to a membership.
	 */
	updateCapacity(
		agentId: string,
		teamId: string,
		newCapacity: number,
	): AgentMembership {
		const membership = this.findMembership(agentId, teamId);
		if (!membership)
			throw new Error(`${agentId} is not a member of team ${teamId}`);

		const agent = this.agents.get(agentId);
		if (agent) {
			const capacityDiff = newCapacity - membership.capacity;
			const availableCapacity = agent.maxCapacity - agent.usedCapacity;
			if (capacityDiff > availableCapacity) {
				throw new Error(
					`Insufficient capacity: need ${capacityDiff} more, available ${availableCapacity}`,
				);
			}
			agent.usedCapacity += capacityDiff;
		}

		membership.capacity = newCapacity;
		membership.lastStatusChange = new Date().toISOString();

		this.recordEvent(agentId, teamId, "capacity-changed", {
			from: membership.capacity,
			to: newCapacity,
		});

		return membership;
	}

	// ─── AC#3: Team Membership Status Tracked ──────────────────────

	/**
	 * Get a specific membership record.
	 */
	getMembership(agentId: string, teamId: string): AgentMembership | undefined {
		return this.findMembership(agentId, teamId);
	}

	/**
	 * Get membership by ID.
	 */
	getMembershipById(membershipId: string): AgentMembership | undefined {
		return this.memberships.get(membershipId);
	}

	/**
	 * Get all memberships matching a filter.
	 */
	getMemberships(filter?: MembershipFilter): AgentMembership[] {
		let results = Array.from(this.memberships.values());

		if (filter) {
			if (filter.agentId)
				results = results.filter((m) => m.agentId === filter.agentId);
			if (filter.teamId)
				results = results.filter((m) => m.teamId === filter.teamId);
			if (filter.proposalId)
				results = results.filter((m) => m.proposalId === filter.proposalId);
			if (filter.status)
				results = results.filter((m) => m.status === filter.status);
			if (filter.role) results = results.filter((m) => m.role === filter.role);
		}

		return results;
	}

	/**
	 * Get team composition report.
	 */
	getTeamComposition(teamId: string): TeamComposition | null {
		const teamMembers = Array.from(this.memberships.values()).filter(
			(m) => m.teamId === teamId && m.status !== "retired",
		);

		if (teamMembers.length === 0) return null;

		const roles: Record<string, number> = {};
		let totalCapacity = 0;
		let activeCount = 0;

		for (const member of teamMembers) {
			roles[member.role] = (roles[member.role] ?? 0) + 1;
			totalCapacity += member.capacity;
			if (member.status === "active") activeCount++;
		}

		// Find missing roles
		const allRoles: TeamRole[] = [
			"owner",
			"contributor",
			"advisor",
			"observer",
		];
		const missingRoles = allRoles.filter((r) => !(roles[r] > 0));

		return {
			teamId,
			proposalId: teamMembers[0].proposalId,
			activeCount,
			totalCount: teamMembers.length,
			roles: roles as Record<TeamRole, number>,
			avgCapacity:
				teamMembers.length > 0 ? totalCapacity / teamMembers.length : 0,
			missingRoles,
			capacityAvailable: 100 - totalCapacity,
		};
	}

	/**
	 * Update contribution metrics for a membership.
	 */
	updateContributions(
		agentId: string,
		teamId: string,
		updates: Partial<ContributionMetrics>,
	): AgentMembership {
		const membership = this.findMembership(agentId, teamId);
		if (!membership)
			throw new Error(`${agentId} is not a member of team ${teamId}`);

		Object.assign(membership.contributions, updates, {
			lastUpdated: new Date().toISOString(),
		});

		return membership;
	}

	/**
	 * Get membership history events.
	 */
	getMembershipHistory(agentId?: string, teamId?: string): MembershipEvent[] {
		let results = [...this.events];

		if (agentId) results = results.filter((e) => e.agentId === agentId);
		if (teamId) results = results.filter((e) => e.teamId === teamId);

		return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	}

	// ─── AC#4: Query Team Memberships Across All Proposals ────────────

	/**
	 * Get all team memberships for an agent.
	 */
	getAgentMemberships(agentId: string): AgentMembership[] {
		return Array.from(this.memberships.values()).filter(
			(m) => m.agentId === agentId,
		);
	}

	/**
	 * Get only active team memberships for an agent.
	 */
	getAgentActiveMemberships(agentId: string): AgentMembership[] {
		return this.getAgentMemberships(agentId).filter(
			(m) => m.status === "active",
		);
	}

	/**
	 * Get agent's current workload summary.
	 */
	getAgentWorkload(agentId: string): {
		agentId: string;
		agentName?: string;
		activeTeams: number;
		totalCapacityUsed: number;
		maxCapacity: number;
		availableCapacity: number;
		teams: Array<{
			teamId: string;
			proposalId: string;
			role: TeamRole;
			capacity: number;
			contributions: ContributionMetrics;
		}>;
	} {
		const agent = this.agents.get(agentId);
		const activeMemberships = this.getAgentActiveMemberships(agentId);

		return {
			agentId,
			agentName: agent?.displayName,
			activeTeams: activeMemberships.length,
			totalCapacityUsed: agent?.usedCapacity ?? 0,
			maxCapacity: agent?.maxCapacity ?? 100,
			availableCapacity:
				(agent?.maxCapacity ?? 100) - (agent?.usedCapacity ?? 0),
			teams: activeMemberships.map((m) => ({
				teamId: m.teamId,
				proposalId: m.proposalId,
				role: m.role,
				capacity: m.capacity,
				contributions: m.contributions,
			})),
		};
	}

	/**
	 * Get team members list.
	 */
	getTeamMembers(teamId: string): Array<{
		agentId: string;
		role: TeamRole;
		status: MembershipStatus;
		capacity: number;
		contributions: ContributionMetrics;
	}> {
		return Array.from(this.memberships.values())
			.filter((m) => m.teamId === teamId && m.status !== "retired")
			.map((m) => ({
				agentId: m.agentId,
				role: m.role,
				status: m.status,
				capacity: m.capacity,
				contributions: m.contributions,
			}));
	}

	/**
	 * Get membership statistics.
	 */
	getStats(): {
		totalMemberships: number;
		activeMemberships: number;
		inactiveMemberships: number;
		retiredMemberships: number;
		totalAgents: number;
		totalTeams: number;
		avgTeamsPerAgent: number;
		avgMembersPerTeam: number;
	} {
		const allMemberships = Array.from(this.memberships.values());
		const uniqueAgents = new Set(allMemberships.map((m) => m.agentId));
		const uniqueTeams = new Set(allMemberships.map((m) => m.teamId));

		const active = allMemberships.filter((m) => m.status === "active");

		return {
			totalMemberships: allMemberships.length,
			activeMemberships: active.length,
			inactiveMemberships: allMemberships.filter((m) => m.status === "inactive")
				.length,
			retiredMemberships: allMemberships.filter((m) => m.status === "retired")
				.length,
			totalAgents: uniqueAgents.size,
			totalTeams: uniqueTeams.size,
			avgTeamsPerAgent:
				uniqueAgents.size > 0 ? active.length / uniqueAgents.size : 0,
			avgMembersPerTeam:
				uniqueTeams.size > 0 ? active.length / uniqueTeams.size : 0,
		};
	}

	/**
	 * Find agents with available capacity.
	 */
	findAvailableAgents(options?: {
		requiredSkills?: string[];
		minCapacity?: number;
		maxTeams?: number;
	}): AgentProfile[] {
		const results: AgentProfile[] = [];

		for (const agent of this.agents.values()) {
			// Check availability
			if (
				agent.availability !== "available" &&
				agent.availability !== "degraded"
			)
				continue;

			// Check capacity
			const availableCapacity = agent.maxCapacity - agent.usedCapacity;
			if (options?.minCapacity && availableCapacity < options.minCapacity)
				continue;

			// Check max teams
			if (options?.maxTeams && agent.activeTeamCount >= options.maxTeams)
				continue;

			// Check skills
			if (options?.requiredSkills) {
				const hasSkills = options.requiredSkills.every((skill) =>
					agent.skills.some((s) =>
						s.toLowerCase().includes(skill.toLowerCase()),
					),
				);
				if (!hasSkills) continue;
			}

			results.push(agent);
		}

		return results;
	}

	// ─── Internal Methods ───────────────────────────────────────────

	private findMembership(
		agentId: string,
		teamId: string,
	): AgentMembership | undefined {
		return Array.from(this.memberships.values()).find(
			(m) =>
				m.agentId === agentId && m.teamId === teamId && m.status !== "retired",
		);
	}

	private findMembershipIncludingRetired(
		agentId: string,
		teamId: string,
	): AgentMembership | undefined {
		return Array.from(this.memberships.values()).find(
			(m) => m.agentId === agentId && m.teamId === teamId,
		);
	}

	private calculateRelevance(
		agent: AgentProfile | undefined,
		team: Team,
		skills?: string[],
	): number {
		if (!agent) return 0.5; // Unknown agent gets neutral relevance

		let score = 0;

		// Capacity match
		const availableCapacity = agent.maxCapacity - agent.usedCapacity;
		score += Math.min(availableCapacity / 50, 1) * 0.3;

		// Skill match
		if (skills || agent.skills.length > 0) {
			const teamSkills = team.members.flatMap((m) => m.skills);
			const matchingSkills = (skills || agent.skills).filter((s) =>
				teamSkills.some((ts) => ts.toLowerCase().includes(s.toLowerCase())),
			);
			const skillMatch =
				matchingSkills.length / Math.max((skills || agent.skills).length, 1);
			score += skillMatch * 0.3;
		}

		// Workload balance (fewer teams = higher relevance)
		const teamScore = 1 - Math.min(agent.activeTeamCount / 5, 1);
		score += teamScore * 0.2;

		// Availability
		if (agent.availability === "available") score += 0.2;
		else if (agent.availability === "degraded") score += 0.1;

		return Math.min(score, 1);
	}

	private getAvailableRoles(team: Team): TeamRole[] {
		const presentRoles = new Set(team.members.map((m) => m.role));
		const allRoles: TeamRole[] = [
			"owner",
			"contributor",
			"advisor",
			"observer",
		];
		return allRoles.filter((r) => !presentRoles.has(r));
	}

	private determineSuggestionReason(
		agent: AgentProfile | undefined,
		_team: Team,
		relevance: number,
		availableRoles: TeamRole[],
	): string {
		if (!agent) return "New agent available for team";
		if (availableRoles.includes("contributor"))
			return "Team needs contributors";
		if (relevance > 0.7) return "High skill and capacity match";
		if (agent.activeTeamCount < 2) return "Agent has available capacity";
		return "Potential match based on skills";
	}

	private determineRole(team: Team, _agentId: string): TeamRole {
		// Check if team has an owner
		const hasOwner = team.members.some((m) => m.role === "owner");
		if (!hasOwner) return "owner";

		// Default to contributor
		return "contributor";
	}

	private recordEvent(
		agentId: string,
		teamId: string,
		event: MembershipEvent["event"],
		metadata?: Record<string, unknown>,
	): void {
		this.events.push({
			eventId: generateId("EVT"),
			agentId,
			teamId,
			event,
			timestamp: new Date().toISOString(),
			metadata,
		});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${prefix}-${timestamp}-${random}`;
}
