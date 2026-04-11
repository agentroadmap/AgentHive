/**
 * SpacetimeDB Proposal Storage Implementation
 *
 * Implements STATE-74: SpacetimeDB Proposal Storage Implementation
 *
 * Provides in-memory implementation of SpacetimeDB tables and reducers
 * for roadmap proposal management. Can be swapped for real SpacetimeDB backend.
 *
 * AC#1: roadmap_proposals and proposal_labels tables ✅
 * AC#2: TypeScript types matching Proposal interface ✅
 * AC#3: CRUD reducers (create_proposal, update_proposal, delete_proposal) ✅
 * AC#4: Query reducers (get_ready_work, get_by_agent, get_by_status) ✅
 * AC#5: Indexes on status, assignee, id fields ✅
 * AC#6: Integration tests for ACID properties and concurrent access ✅
 */

import {
	type ActivityLogRow,
	DEFAULT_MATURITY,
	DEFAULT_PRIORITY,
	DEFAULT_STATUS,
	type CreateProposalInput,
	type DatabaseProposalStatus,
	type PRIORITY_ORDER,
	type RoadmapProposalRow,
	type ProposalLabelRow,
	type ProposalQueryFilter,
	type ProposalQueryOptions,
	type ProposalSortOptions,
	type UpdateProposalInput,
	validateProposalTransition,
} from "./proposal-types.ts";

// ===================== Subscription System =====================

/** Proposal change type */
export type ProposalChangeType = "insert" | "update" | "delete";

/** Subscription callback for proposal changes */
export type ProposalSubscriptionCallback = (
	type: ProposalChangeType,
	proposal: RoadmapProposalRow,
	oldProposal?: RoadmapProposalRow,
	details?: Record<string, unknown>,
) => void;

/** Subscription handle for unsubscribing */
export interface ProposalSubscriptionHandle {
	id: number;
	callback: ProposalSubscriptionCallback;
}

// ===================== Proposal Storage Implementation =====================

/**
 * SpacetimeDB Proposal Storage - In-memory implementation
 *
 * Implements the same logic that would run as SpacetimeDB reducers,
 * providing ACID-like operations for proposal management.
 */
export class SpacetimeDBProposalStorage {
	// Primary tables
	private proposals: Map<string, RoadmapProposalRow> = new Map();
	private labels: Map<number, ProposalLabelRow> = new Map();
	private activityLog: Map<number, ActivityLogRow> = new Map();

	// Auto-increment counters
	private nextLabelId = 1;
	private nextActivityId = 1;

	// Indexes for efficient queries (secondary lookups)
	private proposalsByStatus: Map<DatabaseProposalStatus, Set<string>> = new Map();
	private proposalsByAssignee: Map<string, Set<string>> = new Map();
	private proposalsByLabel: Map<string, Set<string>> = new Map();

	// Subscriptions
	private subscriptions: Map<number, ProposalSubscriptionCallback> = new Map();
	private nextSubId = 1;

	// Proposal claims (STATE-085: completeProposal requires active claim)
	private proposalClaims: Map<string, { agentId: string; claimedAt: number }> = new Map();

	constructor() {
		// Initialize status index
		const statuses: DatabaseProposalStatus[] = [
			"drafts", "ready", "wip", "review", "complete", "defunct", "pending",
		];
		for (const status of statuses) {
			this.proposalsByStatus.set(status, new Set());
		}
	}

	// ===================== Reducer: create_proposal =====================

	/**
	 * Create a new proposal in the database.
	 * AC#3: Creates proposal and associated labels atomically.
	 *
	 * @param input - Proposal creation details
	 * @returns The created proposal row
	 * @throws Error if proposal ID already exists
	 */
	createProposal(input: CreateProposalInput): RoadmapProposalRow {
		// Check for duplicate ID
		if (this.proposals.has(input.id)) {
			throw new Error(`Proposal '${input.id}' already exists`);
		}

		const now = Date.now();
		const assignee = input.assignee ? input.assignee.join(",") : null;
		const dependencies = input.dependencies ? input.dependencies.join(",") : "";

		const proposal: RoadmapProposalRow = {
			id: input.id,
			title: input.title,
			status: input.status ?? DEFAULT_STATUS,
			priority: input.priority ?? DEFAULT_PRIORITY,
			maturity: input.maturity ?? DEFAULT_MATURITY,
			assignee,
			createdDate: now,
			updatedDate: now,
			content: input.content ?? "",
			dependencies,
			type: input.type ?? "operational",
			proposalType: input.proposalType,
			domainId: input.domainId,
			category: input.category,
			ready: input.ready ?? false,
			directive: input.directive ?? null,
		};

		// Insert into primary table
		this.proposals.set(input.id, proposal);

		// Update indexes
		this.updateStatusIndex(input.id, null, proposal.status);
		if (assignee) {
			this.updateAssigneeIndex(input.id, null, assignee);
		}

		// Insert labels
		const labels = input.labels ?? [];
		for (const label of labels) {
			this.addLabel(input.id, label);
		}

		// Log activity
		this.logActivity(input.id, "create", "system", null);

		// Notify subscribers
		this.notifySubscribers("insert", proposal);

		return proposal;
	}

	// ===================== Reducer: update_proposal =====================

	/**
	 * Update an existing proposal.
	 * AC#3: Atomic update with index maintenance.
	 *
	 * @param id - Proposal ID to update
	 * @param updates - Fields to update
	 * @returns The updated proposal row
	 * @throws Error if proposal not found
	 */
	updateProposal(id: string, updates: UpdateProposalInput): RoadmapProposalRow {
		const existing = this.proposals.get(id);
		if (!existing) {
			throw new Error(`Proposal '${id}' not found`);
		}

		const oldProposal = { ...existing };

		// Handle assignee conversion
		const assignee = updates.assignee
			? updates.assignee.join(",")
			: existing.assignee;

		// Handle dependencies conversion
		const dependencies = updates.dependencies
			? updates.dependencies.join(",")
			: existing.dependencies;

		// Build updated proposal
		const updated: RoadmapProposalRow = {
			...existing,
			title: updates.title ?? existing.title,
			status: updates.status ?? existing.status,
			priority: updates.priority ?? existing.priority,
			maturity: updates.maturity ?? existing.maturity,
			assignee,
			content: updates.content ?? existing.content,
			dependencies,
			type: updates.type ?? existing.type,
			proposalType: updates.proposalType ?? existing.proposalType,
			domainId: updates.domainId ?? existing.domainId,
			category: updates.category ?? existing.category,
			ready: updates.ready ?? existing.ready,
			directive: updates.directive !== undefined ? updates.directive : existing.directive,
			updatedDate: Date.now(),
		};

		// Update primary table
		this.proposals.set(id, updated);

		// Update indexes if changed
		if (existing.status !== updated.status) {
			this.updateStatusIndex(id, existing.status, updated.status);
		}

		if (existing.assignee !== assignee) {
			this.updateAssigneeIndex(id, existing.assignee, assignee);
		}

		// Handle label updates
		if (updates.labels !== undefined) {
			this.replaceLabels(id, updates.labels);
		}

		// Log activity if status changed
		if (existing.status !== updated.status) {
			this.logActivity(id, `status:${existing.status}->${updated.status}`, "system", null);
		}

		// Notify subscribers
		this.notifySubscribers("update", updated, oldProposal);

		return updated;
	}

	// ===================== Reducer: delete_proposal =====================

	/**
	 * Delete a proposal and all associated data.
	 * AC#3: Cascading delete of labels and activity log.
	 *
	 * @param id - Proposal ID to delete
	 * @throws Error if proposal not found
	 */
	deleteProposal(id: string): void {
		const proposal = this.proposals.get(id);
		if (!proposal) {
			throw new Error(`Proposal '${id}' not found`);
		}

		// Remove from indexes
		this.updateStatusIndex(id, proposal.status, null);
		this.updateAssigneeIndex(id, proposal.assignee, null);

		// Delete associated labels
		for (const [labelId, label] of this.labels) {
			if (label.proposalId === id) {
				this.labels.delete(labelId);
				// Update label index
				const labelProposals = this.proposalsByLabel.get(label.label);
				if (labelProposals) {
					labelProposals.delete(id);
				}
			}
		}

		// Delete associated activity log
		for (const [activityId, activity] of this.activityLog) {
			if (activity.proposalId === id) {
				this.activityLog.delete(activityId);
			}
		}

		// Delete from primary table
		this.proposals.delete(id);

		// Notify subscribers
		this.notifySubscribers("delete", proposal);
	}

	// ===================== Reducer: transition_proposal =====================

	/**
	 * Transition a proposal to a new status.
	 * Convenience method that validates the transition.
	 * STATE-085: Enforces lifecycle - New → Draft → Review → Active → Accepted → Complete.
	 *
	 * @param id - Proposal ID
	 * @param newStatus - New status
	 * @returns The updated proposal row
	 * @throws Error if transition is invalid
	 */
	transitionProposal(id: string, newStatus: DatabaseProposalStatus): RoadmapProposalRow {
		const existing = this.proposals.get(id);
		if (!existing) {
			throw new Error(`Proposal '${id}' not found`);
		}

		// STATE-085 AC#2: Validate lifecycle transition
		validateProposalTransition(existing.status, newStatus);

		return this.updateProposal(id, { status: newStatus });
	}

	// ===================== Reducer: assign_proposal =====================

	/**
	 * Assign a proposal to one or more agents.
	 *
	 * @param id - Proposal ID
	 * @param agents - Agent IDs to assign
	 * @returns The updated proposal row
	 */
	assignProposal(id: string, agents: string[]): RoadmapProposalRow {
		return this.updateProposal(id, { assignee: agents });
	}

	// ===================== Reducer: claim_proposal (STATE-085) =====================

	/**
	 * Claim a proposal for an agent to work on.
	 * STATE-085: Required before completeProposal can be called.
	 *
	 * @param proposalId - Proposal ID to claim
	 * @param agentId - Agent claiming the proposal
	 * @returns The claim record
	 * @throws Error if proposal not found or already claimed
	 */
	claimProposal(proposalId: string, agentId: string): { agentId: string; claimedAt: number } {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal '${proposalId}' not found`);
		}

		// Check if already claimed by another agent
		const existingClaim = this.proposalClaims.get(proposalId);
		if (existingClaim && existingClaim.agentId !== agentId) {
			throw new Error(
				`Proposal '${proposalId}' is already claimed by agent '${existingClaim.agentId}'`,
			);
		}

		// Create claim
		const claim = { agentId, claimedAt: Date.now() };
		this.proposalClaims.set(proposalId, claim);

		// Log activity
		this.logActivity(proposalId, "claim", agentId, null);

		// Notify subscribers
		this.notifySubscribers("update", proposal);

		return claim;
	}

	// ===================== Reducer: release_proposal (STATE-085) =====================

	/**
	 * Release a claim on a proposal.
	 * STATE-085: Only the claiming agent can release.
	 *
	 * @param proposalId - Proposal ID to release
	 * @param agentId - Agent releasing the proposal
	 * @throws Error if proposal not found or not claimed by this agent
	 */
	releaseProposal(proposalId: string, agentId: string): void {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal '${proposalId}' not found`);
		}

		const claim = this.proposalClaims.get(proposalId);
		if (!claim) {
			throw new Error(`Proposal '${proposalId}' has no active claim`);
		}

		if (claim.agentId !== agentId) {
			throw new Error(
				`Proposal '${proposalId}' is claimed by '${claim.agentId}', not '${agentId}'`,
			);
		}

		// Release claim
		this.proposalClaims.delete(proposalId);

		// Log activity
		this.logActivity(proposalId, "release", agentId, null);

		// Notify subscribers
		this.notifySubscribers("update", proposal);
	}

	// ===================== Reducer: complete_proposal (STATE-085) =====================

	/**
	 * Complete a proposal (transition to Complete).
	 * STATE-085: Requires an active claim by the caller.
	 * STATE-085: Enforces lifecycle - New → Draft → Review → Active → Accepted → Complete.
	 *
	 * @param proposalId - Proposal ID to complete
	 * @param agentId - Agent completing the proposal (must have active claim)
	 * @returns The updated proposal row
	 * @throws Error if proposal not found, no active claim, or invalid transition
	 */
	completeProposal(proposalId: string, agentId: string): RoadmapProposalRow {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal '${proposalId}' not found`);
		}

		// STATE-085 AC#1: Require active claim by the caller
		const claim = this.proposalClaims.get(proposalId);
		if (!claim || claim.agentId !== agentId) {
			throw new Error(
				`Proposal '${proposalId}' must be claimed by '${agentId}' before completion. ` +
				"Call claimProposal first.",
			);
		}

		// STATE-085 AC#2: Enforce lifecycle (New → Draft → Review → Active → Accepted → Complete)
		validateProposalTransition(proposal.status, "complete");

		// Release the claim
		this.proposalClaims.delete(proposalId);

		// Update status to complete
		return this.updateProposal(proposalId, { status: "complete" as DatabaseProposalStatus });
	}

	/**
	 * Check if a proposal has an active claim.
	 *
	 * @param proposalId - Proposal ID to check
	 * @returns The claim record or null if not claimed
	 */
	getClaim(proposalId: string): { agentId: string; claimedAt: number } | null {
		return this.proposalClaims.get(proposalId) ?? null;
	}

	/**
	 * Get all claims for an agent.
	 *
	 * @param agentId - Agent ID
	 * @returns Array of [proposalId, claim] pairs
	 */
	getAgentClaims(agentId: string): Array<{ proposalId: string; claimedAt: number }> {
		const claims: Array<{ proposalId: string; claimedAt: number }> = [];
		for (const [proposalId, claim] of this.proposalClaims) {
			if (claim.agentId === agentId) {
				claims.push({ proposalId, claimedAt: claim.claimedAt });
			}
		}
		return claims;
	}

	// ===================== Query: get_proposal =====================

	/**
	 * Get a single proposal by ID.
	 * AC#4: Direct lookup using primary key index.
	 *
	 * @param id - Proposal ID
	 * @returns The proposal row or undefined
	 */
	getProposal(id: string): RoadmapProposalRow | undefined {
		return this.proposals.get(id);
	}

	// ===================== Query: get_proposals =====================

	/**
	 * Get proposals matching query criteria.
	 * AC#4: Query with filters, sorting, and pagination.
	 * AC#5: Uses indexes for efficient filtering.
	 *
	 * @param options - Query options
	 * @returns Array of matching proposal rows
	 */
	getProposals(options?: ProposalQueryOptions): RoadmapProposalRow[] {
		let results: RoadmapProposalRow[] = [];

		// Start with indexed subset if possible
		if (options?.filter) {
			results = this.getFilteredProposals(options.filter);
		} else {
			results = Array.from(this.proposals.values());
		}

		// Apply sorting
		if (options?.sort) {
			results = this.applySort(results, options.sort);
		}

		// Apply pagination
		if (options?.pagination) {
			const offset = options.pagination.offset ?? 0;
			const limit = options.pagination.limit ?? results.length;
			results = results.slice(offset, offset + limit);
		}

		return results;
	}

	// ===================== Query: get_ready_work =====================

	/**
	 * Get all proposals with status 'ready' that can be claimed.
	 * AC#4: Common query pattern for agent work discovery.
	 *
	 * @returns Array of ready proposals
	 */
	getReadyWork(): RoadmapProposalRow[] {
		return this.getProposals({
			filter: { status: "ready" },
			sort: { field: "priority", direction: "desc" },
		});
	}

	// ===================== Query: get_by_agent =====================

	/**
	 * Get all proposals assigned to a specific agent.
	 * AC#4: Uses assignee index for efficient lookup.
	 *
	 * @param agentId - The agent ID
	 * @returns Array of proposals assigned to the agent
	 */
	getByAgent(agentId: string): RoadmapProposalRow[] {
		return this.getProposals({
			filter: { assignee: agentId },
			sort: { field: "updatedDate", direction: "desc" },
		});
	}

	// ===================== Query: get_by_status =====================

	/**
	 * Get all proposals with a specific status.
	 * AC#4: Uses status index for efficient lookup.
	 *
	 * @param status - The status to filter by
	 * @returns Array of proposals with that status
	 */
	getByStatus(status: DatabaseProposalStatus): RoadmapProposalRow[] {
		return this.getProposals({
			filter: { status },
			sort: { field: "priority", direction: "desc" },
		});
	}

	// ===================== Query: get_by_label =====================

	/**
	 * Get all proposals with a specific label.
	 * Uses label index for efficient lookup.
	 *
	 * @param label - The label to filter by
	 * @returns Array of proposals with that label
	 */
	getByLabel(label: string): RoadmapProposalRow[] {
		const proposalIds = this.proposalsByLabel.get(label);
		if (!proposalIds) return [];

		const results: RoadmapProposalRow[] = [];
		for (const id of proposalIds) {
			const proposal = this.proposals.get(id);
			if (proposal) results.push(proposal);
		}

		return results;
	}

	// ===================== Labels Management =====================

	/**
	 * Add a label to a proposal.
	 *
	 * @param proposalId - Proposal ID
	 * @param label - Label to add
	 * @returns The created label row
	 */
	addLabel(proposalId: string, label: string): ProposalLabelRow {
		if (!this.proposals.has(proposalId)) {
			throw new Error(`Proposal '${proposalId}' not found`);
		}

		// Check for duplicate label
		for (const existing of this.labels.values()) {
			if (existing.proposalId === proposalId && existing.label === label) {
				return existing; // Already exists, return existing
			}
		}

		const labelRow: ProposalLabelRow = {
			id: this.nextLabelId++,
			proposalId,
			label,
		};

		this.labels.set(labelRow.id, labelRow);

		// Update label index
		if (!this.proposalsByLabel.has(label)) {
			this.proposalsByLabel.set(label, new Set());
		}
		this.proposalsByLabel.get(label)!.add(proposalId);

		return labelRow;
	}

	/**
	 * Remove a label from a proposal.
	 *
	 * @param proposalId - Proposal ID
	 * @param label - Label to remove
	 */
	removeLabel(proposalId: string, label: string): void {
		for (const [id, labelRow] of this.labels) {
			if (labelRow.proposalId === proposalId && labelRow.label === label) {
				this.labels.delete(id);

				// Update label index
				const labelProposals = this.proposalsByLabel.get(label);
				if (labelProposals) {
					labelProposals.delete(proposalId);
					if (labelProposals.size === 0) {
						this.proposalsByLabel.delete(label);
					}
				}
				return;
			}
		}
	}

	/**
	 * Get all labels for a proposal.
	 *
	 * @param proposalId - Proposal ID
	 * @returns Array of labels
	 */
	getLabels(proposalId: string): string[] {
		const result: string[] = [];
		for (const label of this.labels.values()) {
			if (label.proposalId === proposalId) {
				result.push(label.label);
			}
		}
		return result;
	}

	/**
	 * Replace all labels for a proposal.
	 */
	private replaceLabels(proposalId: string, newLabels: string[]): void {
		// Remove existing labels
		for (const [id, labelRow] of this.labels) {
			if (labelRow.proposalId === proposalId) {
				this.labels.delete(id);
				// Update label index
				const labelProposals = this.proposalsByLabel.get(labelRow.label);
				if (labelProposals) {
					labelProposals.delete(proposalId);
				}
			}
		}

		// Add new labels
		for (const label of newLabels) {
			this.addLabel(proposalId, label);
		}
	}

	// ===================== Activity Log =====================

	/**
	 * Log an activity for a proposal.
	 *
	 * @param proposalId - Proposal ID
	 * @param action - Action performed
	 * @param agentId - Agent who performed the action
	 * @param details - Additional details
	 */
	logActivity(proposalId: string, action: string, agentId: string, details: string | null): ActivityLogRow {
		const entry: ActivityLogRow = {
			id: this.nextActivityId++,
			proposalId,
			timestamp: Date.now(),
			action,
			agentId,
			details,
		};

		this.activityLog.set(entry.id, entry);
		return entry;
	}

	/**
	 * Get activity log for a proposal.
	 *
	 * @param proposalId - Proposal ID
	 * @returns Array of activity log entries, newest first
	 */
	getActivityLog(proposalId: string): ActivityLogRow[] {
		const results: ActivityLogRow[] = [];
		for (const entry of this.activityLog.values()) {
			if (entry.proposalId === proposalId) {
				results.push(entry);
			}
		}
		return results.sort((a, b) => b.timestamp - a.timestamp);
	}

	// ===================== Statistics =====================

	/**
	 * Get count of proposals by status.
	 *
	 * @returns Map of status to count
	 */
	getStatusCounts(): Map<DatabaseProposalStatus, number> {
		const counts = new Map<DatabaseProposalStatus, number>();
		for (const [status, ids] of this.proposalsByStatus) {
			counts.set(status, ids.size);
		}
		return counts;
	}

	/**
	 * Get total number of proposals.
	 */
	getTotalCount(): number {
		return this.proposals.size;
	}

	/**
	 * Get all registered labels.
	 */
	getAllLabels(): string[] {
		return Array.from(this.proposalsByLabel.keys()).sort();
	}

	// ===================== Subscription System =====================

	/**
	 * Subscribe to proposal changes.
	 *
	 * @param callback - Function called when proposals change
	 * @returns Handle for unsubscribing
	 */
	subscribe(callback: ProposalSubscriptionCallback): ProposalSubscriptionHandle {
		const id = this.nextSubId++;
		this.subscriptions.set(id, callback);
		return { id, callback };
	}

	/**
	 * Unsubscribe from proposal changes.
	 */
	unsubscribe(handle: ProposalSubscriptionHandle): boolean {
		return this.subscriptions.delete(handle.id);
	}

	// ===================== Internal Methods =====================

	/**
	 * Update the status index.
	 */
	private updateStatusIndex(proposalId: string, oldStatus: string | null, newStatus: string | null): void {
		// Remove from old status set
		if (oldStatus) {
			const oldSet = this.proposalsByStatus.get(oldStatus as DatabaseProposalStatus);
			if (oldSet) {
				oldSet.delete(proposalId);
			}
		}

		// Add to new status set
		if (newStatus) {
			const statusKey = newStatus as DatabaseProposalStatus;
			if (!this.proposalsByStatus.has(statusKey)) {
				this.proposalsByStatus.set(statusKey, new Set());
			}
			this.proposalsByStatus.get(statusKey)!.add(proposalId);
		}
	}

	/**
	 * Update the assignee index.
	 */
	private updateAssigneeIndex(proposalId: string, oldAssignee: string | null, newAssignee: string | null): void {
		// Remove from old assignee set
		if (oldAssignee) {
			const oldSet = this.proposalsByAssignee.get(oldAssignee);
			if (oldSet) {
				oldSet.delete(proposalId);
			}
		}

		// Add to new assignee set
		if (newAssignee) {
			if (!this.proposalsByAssignee.has(newAssignee)) {
				this.proposalsByAssignee.set(newAssignee, new Set());
			}
			this.proposalsByAssignee.get(newAssignee)!.add(proposalId);
		}
	}

	/**
	 * Get proposals matching a filter using indexes.
	 */
	private getFilteredProposals(filter: ProposalQueryFilter): RoadmapProposalRow[] {
		let candidates: RoadmapProposalRow[] = [];

		// Use index for most selective filter
		if (filter.status) {
			const ids = this.proposalsByStatus.get(filter.status);
			if (!ids) return [];
			for (const id of ids) {
				const proposal = this.proposals.get(id);
				if (proposal) candidates.push(proposal);
			}
		} else if (filter.label) {
			const ids = this.proposalsByLabel.get(filter.label);
			if (!ids) return [];
			for (const id of ids) {
				const proposal = this.proposals.get(id);
				if (proposal) candidates.push(proposal);
			}
		} else if (filter.assignee) {
			const ids = this.proposalsByAssignee.get(filter.assignee);
			if (!ids) return [];
			for (const id of ids) {
				const proposal = this.proposals.get(id);
				if (proposal) candidates.push(proposal);
			}
		} else {
			candidates = Array.from(this.proposals.values());
		}

		// Apply additional filters
		return candidates.filter((proposal) => {
			if (filter.status && proposal.status !== filter.status) return false;
			if (filter.assignee && proposal.assignee !== filter.assignee) return false;
			if (filter.priority && proposal.priority !== filter.priority) return false;
			if (filter.maturity && proposal.maturity !== filter.maturity) return false;
			if (filter.ready !== undefined && proposal.ready !== filter.ready) return false;
			if (filter.directive && proposal.directive !== filter.directive) return false;
			if (filter.type && proposal.type !== filter.type) return false;
			return true;
		});
	}

	/**
	 * Apply sorting to results.
	 */
	private applySort(proposals: RoadmapProposalRow[], sort: ProposalSortOptions): RoadmapProposalRow[] {
		const sorted = [...proposals];
		const dir = sort.direction === "asc" ? 1 : -1;

		sorted.sort((a, b) => {
			const aVal = a[sort.field];
			const bVal = b[sort.field];

			if (typeof aVal === "string" && typeof bVal === "string") {
				return dir * aVal.localeCompare(bVal);
			}
			if (typeof aVal === "number" && typeof bVal === "number") {
				return dir * (aVal - bVal);
			}
			return 0;
		});

		return sorted;
	}

	/**
	 * Notify all subscribers of a proposal change.
	 */
	private notifySubscribers(
		type: "insert" | "update" | "delete",
		proposal: RoadmapProposalRow,
		oldProposal?: RoadmapProposalRow,
	): void {
		for (const callback of this.subscriptions.values()) {
			try {
				callback(type, proposal, oldProposal);
			} catch {
				// Don't let subscriber errors break the storage
			}
		}
	}
}

// ===================== Singleton Instance =====================

/** Global proposal storage instance for convenience */
export const globalProposalStorage = new SpacetimeDBProposalStorage();
