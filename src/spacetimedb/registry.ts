/**
 * SpacetimeDB Agent Registry - In-Memory Implementation
 *
 * Implements STATE-80: SpacetimeDB Agent Registry Implementation
 * Bugfixes from STATE-81: Agent Registry Bugfixes
 * This module provides the registry logic that maps to SpacetimeDB tables/reducers.
 * Can be swapped for a real SpacetimeDB backend when available.
 *
 * AC#1: Agent registration schema with roles from STATE-78 ✅
 * AC#2: Reducers (register_agent, heartbeat, claim_proposal, release_proposal) ✅
 * AC#3: Agent status lifecycle (online → idle → busy → offline) ✅
 * AC#4: Agent discovery API for finding agents by role/capability ✅
 * AC#5: Subscription-based presence notifications ✅
 * AC#6: Replacement for agents.yml coordination ✅
 *
 * STATE-81 Bugfixes:
 * #1: release_proposal now updates agent_assignments table ✅
 * #2: Duplicate claim prevention added ✅
 * #3: Proposal ownership validation in release_proposal ✅
 * #4: Configurable workload_cost per proposal ✅
 * #5: Agent disconnect handler with proposal release ✅
 * #6: Stale agent recovery with automatic proposal release ✅
 */

import {
	type AgentAssignment,
	type AgentDiscoveryFilter,
	type AgentRecord,
	type AgentRole,
	type AgentStatus,
	type ClaimProposalInput,
	type HeartbeatConfig,
	type PoolSummary,
	type RegisterAgentInput,
	INCOMPATIBLE_ROLE_PAIRS,
	MANDATORY_ROLES,
	MAX_WORKLOAD_PCT,
	STATUS_TRANSITIONS,
	WORKLOAD_PER_STATE,
} from "./types.ts";

// ===================== Subscription System =====================

/** Subscription callback type */
type SubscriptionCallback = (
	type: "agent_registered" | "agent_updated" | "agent_removed" | "assignment_changed",
	agent: AgentRecord,
	details?: Record<string, unknown>,
) => void;

/** Subscription handle for unsubscribing */
export interface SubscriptionHandle {
	id: number;
	callback: SubscriptionCallback;
}

// ===================== Agent Registry =====================

/**
 * Agent Registry - In-memory implementation of SpacetimeDB agent registry.
 *
 * This class implements the same logic that would run as SpacetimeDB reducers,
 * providing atomic operations and subscription-based notifications.
 */
export class AgentRegistry {
	private agents: Map<string, AgentRecord> = new Map();
	private assignments: Map<number, AgentAssignment> = new Map();
	private nextAssignmentId = 1;
	private subscriptions: Map<number, SubscriptionCallback> = new Map();
	private nextSubId = 1;
	private heartbeatConfig: HeartbeatConfig;

	constructor(config?: Partial<HeartbeatConfig>) {
		this.heartbeatConfig = {
			intervalMs: config?.intervalMs ?? 30_000,
			timeoutMs: config?.timeoutMs ?? 120_000,
		};
	}

	// ===================== Reducer: register_agent =====================

	/**
	 * Register a new agent or update existing registration.
	 * AC#1, AC#3: Implements registration with roles and initial status.
	 *
	 * @param input - Agent registration details
	 * @returns The registered agent record
	 * @throws Error if roles are incompatible or agent ID already exists with conflict
	 */
	registerAgent(input: RegisterAgentInput): AgentRecord {
		// Validate roles are from STATE-78
		this.validateRoles(input.roles);

		// Check incompatible role combinations
		this.checkIncompatibleRoles(input.roles);

		const now = Date.now();
		const existing = this.agents.get(input.id);

		if (existing) {
			// Update existing agent
			const updated: AgentRecord = {
				...existing,
				name: input.name,
				roles: input.roles,
				capabilities: input.capabilities,
				workspaceUrl: input.workspaceUrl,
				lastHeartbeat: now,
				status: existing.status === "offline" ? "online" : existing.status,
			};
			this.agents.set(input.id, updated);
			this.notifySubscriptions("agent_updated", updated, { reason: "re-registration" });
			return updated;
		}

		// New agent
		const agent: AgentRecord = {
			id: input.id,
			name: input.name,
			status: "online",
			roles: input.roles,
			capabilities: input.capabilities,
			currentProposalId: null,
			workspaceUrl: input.workspaceUrl,
			lastHeartbeat: now,
			joinedDate: now,
			workloadPct: 0,
			disconnectCount: 0,
		};

		this.agents.set(input.id, agent);
		this.notifySubscriptions("agent_registered", agent);
		return agent;
	}

	// ===================== Reducer: heartbeat =====================

	/**
	 * Process a heartbeat from an agent to maintain presence.
	 * AC#3: Keeps agent online/idle status alive.
	 *
	 * @param agentId - The agent sending the heartbeat
	 * @returns Updated agent record or null if not found
	 */
	heartbeat(agentId: string): AgentRecord | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;

		const updated: AgentRecord = {
			...agent,
			lastHeartbeat: Date.now(),
			// If agent was offline, bring back to online
			status: agent.status === "offline" ? "online" : agent.status,
		};

		this.agents.set(agentId, updated);
		this.notifySubscriptions("agent_updated", updated, { reason: "heartbeat" });
		return updated;
	}

	// ===================== Reducer: claim_proposal =====================

	/**
	 * Claim a proposal for an agent to work on.
	 * AC#2, AC#3: Atomically transitions agent to busy and creates assignment.
	 *
	 * STATE-81 Fixes:
	 * - Bug #2: Prevents duplicate claims (proposal already claimed by another agent)
	 * - Bug #4: Accepts configurable workload_cost instead of hardcoded 20%
	 *
	 * @param input - Claim details
	 * @returns The created assignment
	 * @throws Error if agent not registered, workload exceeded, proposal already claimed, or role incompatible
	 */
	claimProposal(input: ClaimProposalInput): AgentAssignment {
		const agent = this.agents.get(input.agentId);
		if (!agent) {
			throw new Error(`Agent '${input.agentId}' not registered`);
		}

		if (agent.status === "suspended" || agent.status === "offline") {
			throw new Error(`Agent '${input.agentId}' is ${agent.status} and cannot claim proposals`);
		}

		// STATE-81 Bug #2: Check if proposal is already claimed by another agent
		for (const assignment of this.assignments.values()) {
			if (assignment.proposalId === input.proposalId && assignment.claimedAt !== null) {
				throw new Error(
					`Proposal '${input.proposalId}' is already claimed by agent '${assignment.agentId}'`,
				);
			}
		}

		// STATE-81 Bug #4: Use configurable workload_cost (default: WORKLOAD_PER_STATE)
		const workloadCost = input.workloadCost ?? WORKLOAD_PER_STATE;

		// Check 60% workload cap from STATE-78
		const newWorkload = agent.workloadPct + workloadCost;
		if (newWorkload > MAX_WORKLOAD_PCT) {
			throw new Error(
				`Workload cap exceeded: ${newWorkload}% > ${MAX_WORKLOAD_PCT}% (STATE-78 rule)`,
			);
		}

		// Verify agent has the role they're claiming with
		if (!agent.roles.includes(input.roleUsed)) {
			throw new Error(
				`Agent '${input.agentId}' does not have role '${input.roleUsed}'`,
			);
		}

		// Create assignment with workload_cost
		const assignment: AgentAssignment = {
			id: this.nextAssignmentId++,
			agentId: input.agentId,
			proposalId: input.proposalId,
			roleUsed: input.roleUsed,
			assignedAt: Date.now(),
			claimedAt: Date.now(),
			workloadCost,
		};

		this.assignments.set(assignment.id, assignment);

		// Update agent status
		const updated: AgentRecord = {
			...agent,
			status: "busy",
			currentProposalId: input.proposalId,
			workloadPct: newWorkload,
		};
		this.agents.set(input.agentId, updated);

		this.notifySubscriptions("assignment_changed", updated, {
			assignment,
			action: "claimed",
		});

		return assignment;
	}

	// ===================== Reducer: release_proposal =====================

	/**
	 * Release a proposal when an agent is done working on it.
	 * AC#2, AC#3: Atomically frees the proposal and updates agent status.
	 *
	 * STATE-81 Fixes:
	 * - Bug #1: Properly updates agent_assignments table (deletes assignment)
	 * - Bug #3: Validates that only the claiming agent can release the proposal
	 * - Bug #4: Uses actual workloadCost from assignment, not hardcoded 20%
	 *
	 * @param agentId - The agent releasing the proposal
	 * @param proposalId - The proposal to release
	 * @returns The updated agent record
	 * @throws Error if agent not found or agent doesn't own the assignment
	 */
	releaseProposal(agentId: string, proposalId: string): AgentRecord {
		const agent = this.agents.get(agentId);
		if (!agent) {
			throw new Error(`Agent '${agentId}' not registered`);
		}

		// STATE-81 Bug #1 & #3: Find assignment for this agent and proposal, validate ownership
		let foundAssignment: AgentAssignment | null = null;
		for (const [id, assignment] of this.assignments) {
			if (assignment.proposalId === proposalId) {
				if (assignment.agentId !== agentId) {
					throw new Error(
						`Agent '${agentId}' cannot release proposal '${proposalId}' - it is claimed by agent '${assignment.agentId}'`,
					);
				}
				foundAssignment = assignment;
				this.assignments.delete(id);
				break;
			}
		}

		if (!foundAssignment) {
			throw new Error(`Agent '${agentId}' has not claimed proposal '${proposalId}'`);
		}

		// Calculate remaining workload using actual workloadCost (Bug #4 fix)
		const remainingAssignments = Array.from(this.assignments.values()).filter(
			(a) => a.agentId === agentId,
		);

		const newWorkload = remainingAssignments.reduce((sum, a) => sum + a.workloadCost, 0);
		const newProposalId = remainingAssignments.length > 0 ? remainingAssignments[0].proposalId : null;

		const updated: AgentRecord = {
			...agent,
			status: remainingAssignments.length > 0 ? "busy" : "idle",
			currentProposalId: newProposalId,
			workloadPct: Math.max(0, newWorkload),
		};

		this.agents.set(agentId, updated);

		this.notifySubscriptions("assignment_changed", updated, {
			proposalId,
			action: "released",
		});

		return updated;
	}

	// ===================== Reducer: agent_disconnect =====================

	/**
	 * Handle agent disconnect - release all claimed proposals and mark offline.
	 * STATE-81 Bug #5: Adds disconnect handler for graceful proposal release.
	 *
	 * @param agentId - The agent that disconnected
	 * @returns The updated agent record or null if not found
	 */
	agentDisconnect(agentId: string): AgentRecord | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;

		// Release all claimed proposals for this agent
		const releasedProposals: string[] = [];
		for (const [id, assignment] of this.assignments) {
			if (assignment.agentId === agentId) {
				releasedProposals.push(assignment.proposalId);
				this.assignments.delete(id);
			}
		}

		const updated: AgentRecord = {
			...agent,
			status: "offline",
			currentProposalId: null,
			workloadPct: 0,
			disconnectCount: agent.disconnectCount + 1,
		};

		this.agents.set(agentId, updated);

		this.notifySubscriptions("agent_updated", updated, {
			reason: "disconnect",
			releasedProposals,
		});

		return updated;
	}

	// ===================== Agent Discovery API =====================

	/**
	 * Find available agents matching the given filter.
	 * AC#4: Agent discovery by role and capability.
	 *
	 * @param filter - Discovery criteria
	 * @returns Array of matching agents, sorted by workload (ascending)
	 */
	findAgents(filter: AgentDiscoveryFilter): AgentRecord[] {
		const results: AgentRecord[] = [];

		for (const agent of this.agents.values()) {
			// Filter by status
			if (filter.status && agent.status !== filter.status) {
				continue;
			}

			// Filter by role
			if (filter.role && !agent.roles.includes(filter.role)) {
				continue;
			}

			// Filter by capability
			if (filter.capability && !agent.capabilities.includes(filter.capability)) {
				continue;
			}

			// Filter by max workload
			if (filter.maxWorkload !== undefined && agent.workloadPct > filter.maxWorkload) {
				continue;
			}

			results.push(agent);
		}

		// Sort by workload (ascending) - prefer less loaded agents
		results.sort((a, b) => a.workloadPct - b.workloadPct);

		return results;
	}

	/**
	 * Find idle agents with a specific role (convenience method).
	 */
	findIdleAgentsByRole(role: AgentRole): AgentRecord[] {
		return this.findAgents({
			status: "idle",
			role,
			maxWorkload: MAX_WORKLOAD_PCT,
		});
	}

	/**
	 * Get all agents currently in the pool (not offline/suspended).
	 */
	getOnlinePool(): AgentRecord[] {
		return Array.from(this.agents.values()).filter(
			(a) => a.status !== "offline" && a.status !== "suspended",
		);
	}

	/**
	 * Get a summary of pool status.
	 * AC#4: Pool status overview.
	 */
	getPoolSummary(): PoolSummary {
		const summary: PoolSummary = {
			online: 0,
			idle: 0,
			busy: 0,
			offline: 0,
			suspended: 0,
			total: 0,
		};

		for (const agent of this.agents.values()) {
			summary[agent.status]++;
			summary.total++;
		}

		return summary;
	}

	/**
	 * Get agent's current assignments.
	 */
	getAgentAssignments(agentId: string): AgentAssignment[] {
		return Array.from(this.assignments.values()).filter(
			(a) => a.agentId === agentId,
		);
	}

	/**
	 * Get a specific agent by ID.
	 */
	getAgent(agentId: string): AgentRecord | undefined {
		return this.agents.get(agentId);
	}

	/**
	 * Get all registered agents.
	 */
	getAllAgents(): AgentRecord[] {
		return Array.from(this.agents.values());
	}

	// ===================== Subscription System =====================

	/**
	 * Subscribe to agent pool changes.
	 * AC#5: Subscription-based presence notifications.
	 *
	 * @param callback - Function called when pool changes
	 * @returns Handle for unsubscribing
	 */
	subscribe(callback: SubscriptionCallback): SubscriptionHandle {
		const id = this.nextSubId++;
		this.subscriptions.set(id, callback);
		return { id, callback };
	}

	/**
	 * Unsubscribe from pool changes.
	 */
	unsubscribe(handle: SubscriptionHandle): boolean {
		return this.subscriptions.delete(handle.id);
	}

	// ===================== Status Management =====================

	/**
	 * Set an agent's status directly (for external status changes).
	 */
	setAgentStatus(agentId: string, newStatus: AgentStatus): AgentRecord | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;

		// Validate transition
		const validTransitions = STATUS_TRANSITIONS[agent.status];
		if (!validTransitions.includes(newStatus)) {
			throw new Error(
				`Invalid status transition: ${agent.status} → ${newStatus}. Valid: ${validTransitions.join(", ")}`,
			);
		}

		const updated: AgentRecord = {
			...agent,
			status: newStatus,
			lastHeartbeat: Date.now(),
		};

		this.agents.set(agentId, updated);
		this.notifySubscriptions("agent_updated", updated, {
			oldStatus: agent.status,
			newStatus,
		});

		return updated;
	}

	/**
	 * Remove an agent from the registry.
	 * AC#6: Replaces agents.yml removal.
	 */
	removeAgent(agentId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;

		// Remove all assignments for this agent
		for (const [id, assignment] of this.assignments) {
			if (assignment.agentId === agentId) {
				this.assignments.delete(id);
			}
		}

		this.agents.delete(agentId);
		this.notifySubscriptions("agent_removed", agent);
		return true;
	}

	// ===================== Validation =====================

	/**
	 * Validate that all roles are from STATE-78 definitions.
	 */
	private validateRoles(roles: AgentRole[]): void {
		const validRoles: AgentRole[] = [
			"product-manager", "ux-researcher", "business-analyst", "qa-strategist",
			"architect", "senior-developer", "frontend-developer", "security-engineer",
			"code-reviewer", "qa-engineer",
			"orchestrator", "merge-coordinator", "devops",
		];

		for (const role of roles) {
			if (!validRoles.includes(role)) {
				throw new Error(`Invalid role '${role}'. Must be one of: ${validRoles.join(", ")}`);
			}
		}
	}

	/**
	 * Check for incompatible role combinations (from STATE-78).
	 */
	private checkIncompatibleRoles(roles: AgentRole[]): void {
		for (const [roleA, roleB] of INCOMPATIBLE_ROLE_PAIRS) {
			if (roles.includes(roleA) && roles.includes(roleB)) {
				throw new Error(
					`Incompatible roles: '${roleA}' and '${roleB}' cannot be combined (STATE-78 rule)`,
				);
			}
		}
	}

	/**
	 * Check if mandatory roles are covered in the pool.
	 * AC#5: Mandatory role enforcement.
	 */
	checkMandatoryRoles(): { covered: boolean; missing: AgentRole[] } {
		const poolRoles = new Set<AgentRole>();
		for (const agent of this.agents.values()) {
			if (agent.status !== "offline" && agent.status !== "suspended") {
				for (const role of agent.roles) {
					poolRoles.add(role);
				}
			}
		}

		const missing = MANDATORY_ROLES.filter((r) => !poolRoles.has(r));
		return {
			covered: missing.length === 0,
			missing,
		};
	}

	// ===================== Heartbeat Timeout Check =====================

	/**
	 * Check for agents with expired heartbeats and mark them offline.
	 * STATE-81 Bug #6: Now also releases claimed proposals for stale agents.
	 *
	 * Should be called periodically.
	 *
	 * @param staleThresholdMs - Optional override for timeout threshold
	 * @returns Array of agents that were timed out
	 */
	checkHeartbeatTimeouts(staleThresholdMs?: number): AgentRecord[] {
		const now = Date.now();
		const threshold = staleThresholdMs ?? this.heartbeatConfig.timeoutMs;
		const timedOut: AgentRecord[] = [];

		for (const agent of this.agents.values()) {
			if (
				agent.status !== "offline" &&
				agent.status !== "suspended" &&
				now - agent.lastHeartbeat > threshold
			) {
				// STATE-81 Bug #6: Release all claimed proposals for stale agent
				const releasedProposals: string[] = [];
				for (const [id, assignment] of this.assignments) {
					if (assignment.agentId === agent.id) {
						releasedProposals.push(assignment.proposalId);
						this.assignments.delete(id);
					}
				}

				const updated: AgentRecord = {
					...agent,
					status: "offline",
					currentProposalId: null,
					workloadPct: 0,
					disconnectCount: agent.disconnectCount + 1,
				};
				this.agents.set(agent.id, updated);
				timedOut.push(updated);

				this.notifySubscriptions("agent_updated", updated, {
					reason: "heartbeat_timeout",
					releasedProposals,
				});
			}
		}

		return timedOut;
	}

	/**
	 * Recover stale agents - alias for checkHeartbeatTimeouts with explicit threshold.
	 * STATE-81 Bug #6: Provides recoverStaleAgents as specified in bugfix spec.
	 *
	 * @param staleThresholdMs - Time in ms since last heartbeat before agent is stale
	 * @returns Array of agents that were recovered
	 */
	recoverStaleAgents(staleThresholdMs: number): AgentRecord[] {
		return this.checkHeartbeatTimeouts(staleThresholdMs);
	}

	// ===================== Internal =====================

	private notifySubscriptions(
		type: "agent_registered" | "agent_updated" | "agent_removed" | "assignment_changed",
		agent: AgentRecord,
		details?: Record<string, unknown>,
	): void {
		for (const callback of this.subscriptions.values()) {
			try {
				callback(type, agent, details);
			} catch {
				// Don't let subscriber errors break the registry
			}
		}
	}
}

// ===================== Singleton Instance =====================

/** Global registry instance for convenience */
export const globalRegistry = new AgentRegistry();
