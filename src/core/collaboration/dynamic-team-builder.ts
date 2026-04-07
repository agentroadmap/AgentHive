/**
 * STATE-62: Dynamic Team Building
 *
 * Dynamic team building based on proposal evaluation and agent capabilities.
 * Teams form when multiple agents propose solutions to the same proposal,
 * with clear roles and coordination mechanisms.
 *
 * AC#1: Proposals evaluated for same-proposal overlap
 * AC#2: Team formed with clear roles (owner, contributor, advisor)
 * AC#3: Team members notified and can accept/decline roles
 * AC#4: Team coordination through shared lease or lease chain
 */

import type { AgentProposal } from "./agent-proposals.ts";

// ─── Types ───────────────────────────────────────────────────────────────

/** Team member role */
export type TeamRole = "owner" | "contributor" | "advisor" | "observer";

/** Team member status */
export type MemberStatus =
	| "invited"
	| "accepted"
	| "declined"
	| "removed"
	| "inactive";

/** Lease coordination strategy */
export type CoordinationStrategy =
	| "shared-lease"
	| "lease-chain"
	| "owner-only";

/** Team status */
export type TeamStatus =
	| "forming" // Accepting invitations
	| "active" // Team is actively working
	| "paused" // Temporarily paused
	| "completed" // Work is done
	| "dissolved"; // Team disbanded

/** A team member with their role and status */
export interface TeamMember {
	/** Unique member ID (typically agentId) */
	memberId: string;
	/** Display name */
	displayName: string;
	/** Assigned role */
	role: TeamRole;
	/** Current status */
	status: MemberStatus;
	/** When invited */
	invitedAt: string;
	/** When accepted/declined */
	respondedAt?: string;
	/** Skills this member brings */
	skills: string[];
	/** Capacity allocation (0-100%) */
	capacity: number;
	/** Last activity timestamp */
	lastActivity?: string;
}

/** Proposal overlap - proposals targeting the same proposal */
export interface ProposalOverlap {
	/** Proposal ID being proposed for */
	proposalId: string;
	/** Proposals that target this proposal */
	proposals: AgentProposal[];
	/** Similarity score (0-1) */
	similarity: number;
	/** Suggested team size */
	suggestedTeamSize: number;
	/** Recommended roles */
	recommendedRoles: Array<{
		role: TeamRole;
		skills: string[];
		justification: string;
	}>;
}

/** Team structure */
export interface Team {
	/** Unique team ID */
	teamId: string;
	/** Proposal this team is working on */
	proposalId: string;
	/** Current status */
	status: TeamStatus;
	/** Team members with roles */
	members: TeamMember[];
	/** The owner/proposer agent */
	ownerId: string;
	/** Coordination strategy */
	coordinationStrategy: CoordinationStrategy;
	/** Shared lease ID (if using shared-lease) */
	sharedLeaseId?: string;
	/** Lease chain (if using lease-chain) */
	leaseChain: LeaseChainEntry[];
	/** Formed from which proposals */
	proposalIds: string[];
	/** When team was formed */
	createdAt: string;
	/** When team became active */
	activatedAt?: string;
	/** When team completed/dissolved */
	completedAt?: string;
	/** Meeting cadence or sync schedule */
	syncSchedule?: string;
	/** Team summary/description */
	description: string;
	/** Capacity percentage for the team */
	capacity: number;
}

/** Lease chain entry for sequential work coordination */
export interface LeaseChainEntry {
	/** Agent holding this segment of the chain */
	agentId: string;
	/** Order in the chain */
	position: number;
	/** Task description for this segment */
	task: string;
	/** Status */
	status: "pending" | "active" | "completed" | "skipped";
	/** Started at timestamp */
	startedAt?: string;
	/** Completed at timestamp */
	completedAt?: string;
}

/** Team event for history tracking */
export interface TeamEvent {
	/** Event ID */
	eventId: string;
	/** Team ID */
	teamId: string;
	/** Event type */
	event:
		| "formed"
		| "member-joined"
		| "member-left"
		| "member-invited"
		| "role-changed"
		| "activated"
		| "paused"
		| "completed"
		| "dissolved"
		| "lease-transferred";
	/** Agent that caused the event */
	triggeredBy: string;
	/** Timestamp */
	timestamp: string;
	/** Additional context */
	metadata?: Record<string, unknown>;
}

/** Filter for team queries */
export interface TeamFilter {
	proposalId?: string;
	status?: TeamStatus;
	memberId?: string;
	ownerId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Maximum members per team for initial formation */
const DEFAULT_MAX_TEAM_SIZE = 5;

/** Minimum similarity score for overlap detection */
const _MIN_OVERLAP_SIMILARITY = 0.3;

/** Default sync schedule */
const DEFAULT_SYNC_SCHEDULE = "daily";

// ─── Dynamic Team Builder ───────────────────────────────────────────────

/**
 * Manages dynamic team formation and coordination for multi-agent work.
 */
export class DynamicTeamBuilder {
	private teams: Map<string, Team> = new Map();
	private events: TeamEvent[] = [];

	// ─── AC#1: Proposals Evaluated for Same-Proposal Overlap ──────────

	/**
	 * Analyze proposals for overlap on the same proposal.
	 * Returns overlap analysis when multiple proposals target the same proposal.
	 */
	evaluateOverlap(proposals: AgentProposal[]): ProposalOverlap[] {
		const byProposal = new Map<string, AgentProposal[]>();

		// Group proposals by proposal
		for (const proposal of proposals) {
			const existing = byProposal.get(proposal.proposalId) ?? [];
			existing.push(proposal);
			byProposal.set(proposal.proposalId, existing);
		}

		// Find overlaps (proposals with multiple proposals)
		const overlaps: ProposalOverlap[] = [];

		for (const [proposalId, proposalProposals] of byProposal) {
			if (proposalProposals.length < 2) continue;

			// Calculate similarity between proposals
			const similarity = this.calculateSimilarity(proposalProposals);

			// Determine suggested team size based on complexity
			const avgComplexity =
				proposalProposals.reduce((sum, p) => sum + p.complexity.score, 0) /
				proposalProposals.length;

			const suggestedTeamSize = Math.min(
				Math.max(2, Math.ceil(avgComplexity / 3)),
				DEFAULT_MAX_TEAM_SIZE,
			);

			// Recommend roles based on proposal approaches
			const recommendedRoles = this.recommendRoles(
				proposalProposals,
				avgComplexity,
			);

			overlaps.push({
				proposalId,
				proposals: proposalProposals,
				similarity,
				suggestedTeamSize,
				recommendedRoles,
			});
		}

		// Sort by overlap (most overlapping first)
		overlaps.sort((a, b) => b.proposals.length - a.proposals.length);

		return overlaps;
	}

	/**
	 * Calculate similarity between proposals for the same proposal.
	 */
	private calculateSimilarity(proposals: AgentProposal[]): number {
		if (proposals.length < 2) return 1;

		let totalSimilarity = 0;
		let pairs = 0;

		for (let i = 0; i < proposals.length; i++) {
			for (let j = i + 1; j < proposals.length; j++) {
				const a = proposals[i]!;
				const b = proposals[j]!;

				// Compare approach types
				const approachMatch = a.approach.type === b.approach.type ? 1 : 0;

				// Compare file overlap
				const filesA = new Set(a.approach.filesAffected);
				const filesB = new Set(b.approach.filesAffected);
				const intersection = [...filesA].filter((f) => filesB.has(f)).length;
				const union = new Set([...filesA, ...filesB]).size;
				const fileOverlap = union > 0 ? intersection / union : 0;

				// Compare complexity
				const complexityDiff = Math.abs(
					a.complexity.score - b.complexity.score,
				);
				const complexityMatch = 1 - complexityDiff / 10;

				// Weighted average
				const sim =
					approachMatch * 0.3 + fileOverlap * 0.4 + complexityMatch * 0.3;
				totalSimilarity += sim;
				pairs++;
			}
		}

		return pairs > 0 ? totalSimilarity / pairs : 0;
	}

	/**
	 * Recommend roles based on proposals and complexity.
	 */
	private recommendRoles(
		proposals: AgentProposal[],
		avgComplexity: number,
	): Array<{ role: TeamRole; skills: string[]; justification: string }> {
		const roles: Array<{
			role: TeamRole;
			skills: string[];
			justification: string;
		}> = [];

		// Always need an owner (lead proposer)
		roles.push({
			role: "owner",
			skills: ["leadership", "architecture"],
			justification: "Lead implementation and coordinate team",
		});

		// Need contributors for complex work
		if (avgComplexity > 5) {
			roles.push({
				role: "contributor",
				skills: ["implementation", "testing"],
				justification: "Split implementation workload for faster delivery",
			});
		}

		// Very complex work benefits from advisor
		if (avgComplexity > 7) {
			roles.push({
				role: "advisor",
				skills: ["domain-expertise", "review"],
				justification: "Provide guidance on complex architectural decisions",
			});
		}

		// If many proposals, likely need more contributors
		if (proposals.length > 3) {
			roles.push({
				role: "contributor",
				skills: ["implementation"],
				justification: "Additional capacity for multi-proposer proposals",
			});
		}

		return roles.slice(0, DEFAULT_MAX_TEAM_SIZE);
	}

	// ─── AC#2: Team Formed with Clear Roles ─────────────────────────

	/**
	 * Form a team from proposals targeting the same proposal.
	 */
	formTeam(
		proposalId: string,
		proposals: AgentProposal[],
		options?: {
			coordinationStrategy?: CoordinationStrategy;
			description?: string;
			syncSchedule?: string;
		},
	): Team {
		if (proposals.length < 2) {
			throw new Error("Need at least 2 proposals to form a team");
		}

		const allSameProposal = proposals.every((p) => p.proposalId === proposalId);
		if (!allSameProposal) {
			throw new Error("All proposals must target the same proposal");
		}

		const strategy =
			options?.coordinationStrategy ?? this.determineStrategy(proposals);
		const teamId = generateId("TEAM");

		// Determine owner: highest complexity score, then first proposal
		const sortedByComplexity = [...proposals].sort(
			(a, b) => b.complexity.score - a.complexity.score,
		);
		const ownerProposal = sortedByComplexity[0];

		// Create team members from proposals
		const members: TeamMember[] = [];
		const ownerMember = this.proposalToMember(ownerProposal!, "owner", 100);
		members.push(ownerMember);

		// Assign remaining proposers as contributors
		for (let i = 1; i < sortedByComplexity.length; i++) {
			const member = this.proposalToMember(
				sortedByComplexity[i]!,
				i === 1 ? "contributor" : "contributor",
				Math.floor(60 / (sortedByComplexity.length - 1)),
			);
			members.push(member);
		}

		// Create lease chain if using that strategy
		const leaseChain =
			strategy === "lease-chain"
				? this.createLeaseChain(members, proposals)
				: [];

		const now = new Date().toISOString();
		const team: Team = {
			teamId,
			proposalId,
			status: "forming",
			members,
			ownerId: ownerProposal?.agentId,
			coordinationStrategy: strategy,
			leaseChain,
			proposalIds: proposals.map((p) => p.proposalId),
			createdAt: now,
			description:
				options?.description ??
				`Team for ${proposalId} formed from ${proposals.length} proposals`,
			syncSchedule: options?.syncSchedule ?? DEFAULT_SYNC_SCHEDULE,
			capacity: members.reduce((sum, m) => sum + m.capacity, 0),
		};

		this.teams.set(teamId, team);
		this.recordEvent(teamId, "formed", ownerProposal?.agentId, {
			memberCount: members.length,
			strategy,
		});

		return team;
	}

	/**
	 * Get a team by ID.
	 */
	getTeam(teamId: string): Team | undefined {
		return this.teams.get(teamId);
	}

	/**
	 * Get all teams matching a filter.
	 */
	getTeams(filter?: TeamFilter): Team[] {
		let results = Array.from(this.teams.values());

		if (filter) {
			if (filter.proposalId) {
				results = results.filter((t) => t.proposalId === filter.proposalId);
			}
			if (filter.status) {
				results = results.filter((t) => t.status === filter.status);
			}
			if (filter.memberId) {
				results = results.filter((t) =>
					t.members.some((m) => m.memberId === filter.memberId),
				);
			}
			if (filter.ownerId) {
				results = results.filter((t) => t.ownerId === filter.ownerId);
			}
		}

		return results;
	}

	/**
	 * Get the team for a specific proposal (if any).
	 */
	getTeamForProposal(proposalId: string): Team | undefined {
		return Array.from(this.teams.values()).find(
			(t) =>
				t.proposalId === proposalId &&
				(t.status === "forming" || t.status === "active"),
		);
	}

	// ─── AC#3: Team Members Notified and Can Accept/Decline ────────

	/**
	 * Invite a member to join a team.
	 */
	inviteMember(
		teamId: string,
		agentId: string,
		options?: {
			role?: TeamRole;
			skills?: string[];
			capacity?: number;
			invitedBy?: string;
		},
	): TeamMember {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);
		if (team.status !== "forming") {
			throw new Error(`Cannot invite to team in status: ${team.status}`);
		}

		// Check if already a member
		if (team.members.some((m) => m.memberId === agentId)) {
			throw new Error(`${agentId} is already a team member`);
		}

		const member: TeamMember = {
			memberId: agentId,
			displayName: agentId,
			role: options?.role ?? "contributor",
			status: "invited",
			invitedAt: new Date().toISOString(),
			skills: options?.skills ?? [],
			capacity: options?.capacity ?? 50,
		};

		team.members.push(member);
		team.capacity += member.capacity;

		this.recordEvent(
			teamId,
			"member-invited",
			options?.invitedBy ?? team.ownerId,
			{
				newMember: agentId,
				role: member.role,
			},
		);

		return member;
	}

	/**
	 * Accept a team invitation.
	 */
	acceptInvitation(teamId: string, agentId: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const member = team.members.find((m) => m.memberId === agentId);
		if (!member) throw new Error(`${agentId} is not a team member`);
		if (member.status !== "invited") {
			throw new Error(`${agentId} invitation status is: ${member.status}`);
		}

		member.status = "accepted";
		member.respondedAt = new Date().toISOString();
		member.lastActivity = member.respondedAt;

		this.recordEvent(teamId, "member-joined", agentId, { role: member.role });

		return team;
	}

	/**
	 * Decline a team invitation.
	 */
	declineInvitation(teamId: string, agentId: string, reason?: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const member = team.members.find((m) => m.memberId === agentId);
		if (!member) throw new Error(`${agentId} is not a team member`);
		if (member.status !== "invited") {
			throw new Error(`${agentId} invitation status is: ${member.status}`);
		}

		member.status = "declined";
		member.respondedAt = new Date().toISOString();

		this.recordEvent(teamId, "member-left", agentId, {
			reason: reason ?? "declined",
		});

		// Update team capacity
		team.capacity -= member.capacity;

		return team;
	}

	/**
	 * Remove a member from the team.
	 */
	removeMember(teamId: string, agentId: string, removedBy: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const member = team.members.find((m) => m.memberId === agentId);
		if (!member) throw new Error(`${agentId} is not a team member`);

		member.status = "removed";
		team.capacity -= member.capacity;

		this.recordEvent(teamId, "member-left", removedBy, {
			removedMember: agentId,
			reason: "removed",
		});

		return team;
	}

	/**
	 * Change a member's role.
	 */
	changeRole(
		teamId: string,
		agentId: string,
		newRole: TeamRole,
		changedBy: string,
	): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const member = team.members.find((m) => m.memberId === agentId);
		if (!member) throw new Error(`${agentId} is not a team member`);

		const oldRole = member.role;
		member.role = newRole;

		// If changing to owner, update team owner
		if (newRole === "owner") {
			team.ownerId = agentId;
		}

		this.recordEvent(teamId, "role-changed", changedBy, {
			member: agentId,
			oldRole,
			newRole,
		});

		return team;
	}

	/**
	 * Get pending invitations for an agent.
	 */
	getInvitations(agentId: string): Array<{ team: Team; member: TeamMember }> {
		const invitations: Array<{ team: Team; member: TeamMember }> = [];

		for (const team of this.teams.values()) {
			const member = team.members.find(
				(m) => m.memberId === agentId && m.status === "invited",
			);
			if (member) {
				invitations.push({ team, member });
			}
		}

		return invitations;
	}

	// ─── AC#4: Team Coordination Through Shared Lease or Chain ─────

	/**
	 * Activate a team (all invited members have accepted).
	 */
	activateTeam(teamId: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		const acceptedMembers = team.members.filter((m) => m.status === "accepted");
		if (acceptedMembers.length < 2) {
			throw new Error(
				`Need at least 2 accepted members to activate, got ${acceptedMembers.length}`,
			);
		}

		team.status = "active";
		team.activatedAt = new Date().toISOString();

		// Activate first lease chain entry if using that strategy
		if (
			team.coordinationStrategy === "lease-chain" &&
			team.leaseChain.length > 0
		) {
			team.leaseChain[0]!.status = "active";
			team.leaseChain[0]!.startedAt = new Date().toISOString();
		}

		this.recordEvent(teamId, "activated", team.ownerId, {
			memberCount: acceptedMembers.length,
		});

		return team;
	}

	/**
	 * Complete the team's work.
	 */
	completeTeam(teamId: string, completedBy: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		team.status = "completed";
		team.completedAt = new Date().toISOString();

		// Mark all lease chain entries as completed
		for (const entry of team.leaseChain) {
			if (entry.status === "active") {
				entry.status = "completed";
				entry.completedAt = new Date().toISOString();
			}
		}

		this.recordEvent(teamId, "completed", completedBy, {});
		return team;
	}

	/**
	 * Dissolve a team.
	 */
	dissolveTeam(teamId: string, dissolvedBy: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		team.status = "dissolved";
		team.completedAt = new Date().toISOString();

		this.recordEvent(teamId, "dissolved", dissolvedBy, {});
		return team;
	}

	/**
	 * Transfer lease to the next agent in the chain.
	 */
	transferLease(
		teamId: string,
		fromAgentId: string,
		completedTask?: string,
	): {
		success: boolean;
		newHolder?: string;
		message: string;
	} {
		const team = this.teams.get(teamId);
		if (!team) return { success: false, message: "Team not found" };
		if (team.coordinationStrategy !== "lease-chain") {
			return {
				success: false,
				message: "Team does not use lease-chain coordination",
			};
		}

		// Find current active entry
		const currentIndex = team.leaseChain.findIndex(
			(e) => e.status === "active",
		);
		if (currentIndex < 0) {
			return { success: false, message: "No active lease in chain" };
		}

		const current = team.leaseChain[currentIndex]!;
		if (current.agentId !== fromAgentId) {
			return {
				success: false,
				message: `Lease held by ${current.agentId}, not ${fromAgentId}`,
			};
		}

		// Complete current entry
		current.status = "completed";
		current.completedAt = new Date().toISOString();
		if (completedTask) current.task = completedTask;

		// Activate next entry
		const nextIndex = currentIndex + 1;
		if (nextIndex < team.leaseChain.length) {
			const next = team.leaseChain[nextIndex]!;
			next.status = "active";
			next.startedAt = new Date().toISOString();

			this.recordEvent(teamId, "lease-transferred", fromAgentId, {
				to: next.agentId,
				position: next.position,
			});

			return {
				success: true,
				newHolder: next.agentId,
				message: `Lease transferred to ${next.agentId}`,
			};
		}

		// No more entries - chain complete
		team.status = "completed";
		team.completedAt = new Date().toISOString();

		this.recordEvent(teamId, "completed", fromAgentId, {
			reason: "lease-chain-completed",
		});

		return {
			success: true,
			message: "Lease chain completed - all tasks done",
		};
	}

	/**
	 * Get current lease holder in a chain.
	 */
	getCurrentLeaseHolder(teamId: string): string | undefined {
		const team = this.teams.get(teamId);
		if (!team) return undefined;

		const active = team.leaseChain.find((e) => e.status === "active");
		return active?.agentId;
	}

	/**
	 * Get team coordination info.
	 */
	getCoordinationInfo(teamId: string): {
		strategy: CoordinationStrategy;
		currentHolder?: string;
		chainProgress?: { completed: number; total: number };
		sharedLeaseId?: string;
	} | null {
		const team = this.teams.get(teamId);
		if (!team) return null;

		return {
			strategy: team.coordinationStrategy,
			currentHolder: this.getCurrentLeaseHolder(teamId),
			chainProgress:
				team.leaseChain.length > 0
					? {
							completed: team.leaseChain.filter((e) => e.status === "completed")
								.length,
							total: team.leaseChain.length,
						}
					: undefined,
			sharedLeaseId: team.sharedLeaseId,
		};
	}

	/**
	 * Pause a team.
	 */
	pauseTeam(teamId: string, pausedBy: string): Team {
		const team = this.teams.get(teamId);
		if (!team) throw new Error(`Team not found: ${teamId}`);

		team.status = "paused";
		this.recordEvent(teamId, "paused", pausedBy, {});

		return team;
	}

	/**
	 * Get team history/events.
	 */
	getTeamHistory(teamId: string): TeamEvent[] {
		return this.events.filter((e) => e.teamId === teamId);
	}

	/**
	 * Get team statistics.
	 */
	getTeamStats(): {
		totalTeams: number;
		formingTeams: number;
		activeTeams: number;
		completedTeams: number;
		dissolvedTeams: number;
		avgTeamSize: number;
	} {
		const teams = Array.from(this.teams.values());
		return {
			totalTeams: teams.length,
			formingTeams: teams.filter((t) => t.status === "forming").length,
			activeTeams: teams.filter((t) => t.status === "active").length,
			completedTeams: teams.filter((t) => t.status === "completed").length,
			dissolvedTeams: teams.filter((t) => t.status === "dissolved").length,
			avgTeamSize:
				teams.length > 0
					? teams.reduce((sum, t) => sum + t.members.length, 0) / teams.length
					: 0,
		};
	}

	// ─── Internal Methods ───────────────────────────────────────────

	private determineStrategy(proposals: AgentProposal[]): CoordinationStrategy {
		if (proposals.length === 2) return "owner-only";
		if (proposals.length === 3) return "lease-chain";
		return "shared-lease";
	}

	private proposalToMember(
		proposal: AgentProposal,
		role: TeamRole,
		capacity: number,
	): TeamMember {
		return {
			memberId: proposal.agentId,
			displayName: proposal.agentId,
			role,
			status: proposal.status === "approved" ? "accepted" : "invited",
			invitedAt: proposal.submittedAt,
			respondedAt:
				proposal.status === "approved" ? proposal.submittedAt : undefined,
			skills: [
				proposal.approach.type,
				...proposal.approach.dependencies.slice(0, 3),
			],
			capacity,
		};
	}

	private createLeaseChain(
		members: TeamMember[],
		_proposals: AgentProposal[],
	): LeaseChainEntry[] {
		// Sort members by role priority: owner first, then contributors
		const sortedMembers = [...members].sort((a, b) => {
			const priority: Record<TeamRole, number> = {
				owner: 0,
				contributor: 1,
				advisor: 2,
				observer: 3,
			};
			return (priority[a.role] ?? 99) - (priority[b.role] ?? 99);
		});

		return sortedMembers.map((member, index) => ({
			agentId: member.memberId,
			position: index,
			task: `Segment ${index + 1}: ${member.role} work`,
			status: index === 0 ? "pending" : "pending",
		}));
	}

	private recordEvent(
		teamId: string,
		event: TeamEvent["event"],
		triggeredBy: string,
		metadata?: Record<string, unknown>,
	): void {
		this.events.push({
			eventId: generateId("EVT"),
			teamId,
			event,
			triggeredBy,
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
