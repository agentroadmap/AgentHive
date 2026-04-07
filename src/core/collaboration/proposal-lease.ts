/**
 * STATE-61: Agent Proposal & Lease-Based Backlog System
 *
 * Any agent can propose a component. Approval is a process (not a status).
 * Backlog items can be leased for limited time.
 *
 * AC#1: Any agent can propose via 'proposal_propose' MCP tool or group-pulse discussion
 * AC#2: Proposal reviewed by PM/Architect through discussion thread
 * AC#3: Approval recorded in proposal notes (proposer, approver, timestamp)
 * AC#4: Approved backlog items can be leased for configurable time window (default 48h)
 * AC#5: When lease expires, item returns to backlog for any agent to pick up
 * AC#6: Lease renewal requires heartbeat proof (connects to STATE-7)
 * AC#7: All proposals tracked in group-pulse.md with agent attribution
 */

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type ProposalStatus =
	| "proposed"
	| "in-review"
	| "approved"
	| "rejected"
	| "implemented";
export type LeaseStatus = "active" | "expired" | "released" | "revoked";

export interface Proposal {
	proposalId: string;
	title: string;
	description: string;
	proposedBy: string;
	proposedAt: string;
	status: ProposalStatus;
	reviewThreadId?: string;
	approvedBy?: string;
	approvedAt?: string;
	rejectedBy?: string;
	rejectedAt?: string;
	rejectionReason?: string;
	tags: string[];
	priority: "low" | "medium" | "high" | "critical";
	dependencies: string[];
	estimatedEffort?: string; // XS/S/M/L/XL
	metadata: Record<string, string>;
}

export interface ProposalReview {
	reviewId: string;
	proposalId: string;
	reviewerId: string;
	reviewerRole: "pm" | "architect" | "lead" | "peer";
	recommendation: "approve" | "reject" | "needs-revision";
	score: number; // 1-10
	comments: string;
	reviewedAt: string;
}

export interface Lease {
	leaseId: string;
	proposalId: string;
	agentId: string;
	grantedAt: string;
	expiresAt: string;
	status: LeaseStatus;
	heartbeatToken?: string;
	lastHeartbeat?: string;
	renewalCount: number;
	maxRenewals: number;
	leaseReason?: string;
	releasedAt?: string;
	releaseReason?: string;
}

export interface LeaseRenewalProof {
	leaseId: string;
	agentId: string;
	heartbeatHash: string;
	timestamp: string;
	nonce: string;
}

export interface BacklogItem {
	itemId: string;
	proposalId: string;
	title: string;
	description: string;
	addedBy: string;
	addedAt: string;
	tags: string[];
	priority: "low" | "medium" | "high" | "critical";
	status: "available" | "leased" | "in-progress" | "completed";
	currentLeaseId?: string;
	leaseHistory: string[]; // Lease IDs
}

export interface GroupPulseEntry {
	entryId: string;
	agentId: string;
	type: "proposal" | "comment" | "review" | "lease" | "release";
	content: string;
	timestamp: string;
	relatedId?: string; // proposalId, leaseId, etc.
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_LEASE_DURATION_MS = 48 * 60 * 60 * 1000; // 48 hours
const DEFAULT_MAX_RENEWALS = 3;
const _DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const LEASE_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Proposal & Lease Manager ───────────────────────────────────────

export class ProposalLeaseManager {
	private proposals: Map<string, Proposal> = new Map();
	private reviews: Map<string, ProposalReview[]> = new Map();
	private leases: Map<string, Lease> = new Map();
	private backlog: Map<string, BacklogItem> = new Map();
	private groupPulse: GroupPulseEntry[] = [];
	private expiryCheckInterval: ReturnType<typeof setInterval> | null = null;
	private configDir: string;

	constructor(configDir: string = ".roadmap/proposals") {
		this.configDir = configDir;
	}

	/**
	 * Initialize the manager and start background tasks.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		await this.loadProposal();
		this.startExpiryChecker();
	}

	/**
	 * Shutdown the manager.
	 */
	shutdown(): void {
		if (this.expiryCheckInterval) {
			clearInterval(this.expiryCheckInterval);
			this.expiryCheckInterval = null;
		}
	}

	// ─── AC#1: Agent Proposal ──────────────────────────────────────

	/**
	 * Submit a new proposal.
	 */
	submitProposal(options: {
		proposalId: string;
		title: string;
		description: string;
		proposedBy: string;
		tags?: string[];
		priority?: "low" | "medium" | "high" | "critical";
		dependencies?: string[];
		estimatedEffort?: string;
		metadata?: Record<string, string>;
	}): Proposal {
		// Check if there's already a proposal for this proposal
		const existing = this.getProposalByProposal(options.proposalId);
		if (existing && existing.status !== "rejected") {
			throw new Error(
				`Active proposal already exists for ${options.proposalId}`,
			);
		}

		const proposal: Proposal = {
			proposalId: options.proposalId,
			title: options.title,
			description: options.description,
			proposedBy: options.proposedBy,
			proposedAt: new Date().toISOString(),
			status: "proposed",
			tags: options.tags || [],
			priority: options.priority || "medium",
			dependencies: options.dependencies || [],
			estimatedEffort: options.estimatedEffort,
			metadata: options.metadata || {},
		};

		this.proposals.set(proposal.proposalId, proposal);
		this.reviews.set(proposal.proposalId, []);

		// Add to group pulse
		this.addPulseEntry({
			agentId: options.proposedBy,
			type: "proposal",
			content: `Proposed: ${options.title} (${options.proposalId})`,
			relatedId: proposal.proposalId,
		});

		return proposal;
	}

	/**
	 * Add a comment to a proposal (for discussion thread).
	 */
	addProposalComment(
		proposalId: string,
		agentId: string,
		content: string,
	): GroupPulseEntry {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		const entry = this.addPulseEntry({
			agentId,
			type: "comment",
			content: `[${proposalId}] ${content}`,
			relatedId: proposalId,
		});

		// Update proposal status to in-review if first comment
		if (proposal.status === "proposed") {
			proposal.status = "in-review";
		}

		return entry;
	}

	// ─── AC#2: PM/Architect Review ─────────────────────────────────

	/**
	 * Submit a review for a proposal.
	 */
	submitReview(options: {
		proposalId: string;
		reviewerId: string;
		reviewerRole: "pm" | "architect" | "lead" | "peer";
		recommendation: "approve" | "reject" | "needs-revision";
		score: number;
		comments: string;
	}): ProposalReview {
		const proposal = this.proposals.get(options.proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${options.proposalId}`);
		}

		if (proposal.status === "rejected" || proposal.status === "implemented") {
			throw new Error(`Cannot review proposal in status: ${proposal.status}`);
		}

		// Check if reviewer already reviewed with same role (only one review per role)
		const existingReviews = this.reviews.get(options.proposalId) || [];
		const existingRoleReview = existingReviews.find(
			(r) => r.reviewerRole === options.reviewerRole,
		);
		if (existingRoleReview) {
			throw new Error(
				`A ${options.reviewerRole} review already exists (by ${existingRoleReview.reviewerId})`,
			);
		}

		const review: ProposalReview = {
			reviewId: `REV-${randomUUID().slice(0, 8)}`,
			proposalId: options.proposalId,
			reviewerId: options.reviewerId,
			reviewerRole: options.reviewerRole,
			recommendation: options.recommendation,
			score: Math.max(1, Math.min(10, options.score)),
			comments: options.comments,
			reviewedAt: new Date().toISOString(),
		};

		existingReviews.push(review);
		this.reviews.set(options.proposalId, existingReviews);

		// Add to group pulse
		this.addPulseEntry({
			agentId: options.reviewerId,
			type: "review",
			content: `Reviewed ${options.proposalId}: ${options.recommendation} (score: ${options.score})`,
			relatedId: options.proposalId,
		});

		return review;
	}

	// ─── AC#3: Approval Recording ──────────────────────────────────

	/**
	 * Approve a proposal (requires PM + Architect approval).
	 */
	approveProposal(proposalId: string, approverId: string): Proposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		const reviews = this.reviews.get(proposalId) || [];

		// Check for PM approval
		const pmReview = reviews.find(
			(r) => r.reviewerRole === "pm" && r.recommendation === "approve",
		);
		// Check for Architect approval
		const archReview = reviews.find(
			(r) => r.reviewerRole === "architect" && r.recommendation === "approve",
		);

		if (!pmReview || !archReview) {
			throw new Error(
				`Cannot approve: requires both PM and Architect approval. ` +
					`PM: ${pmReview ? "approved" : "pending"}, Architect: ${archReview ? "approved" : "pending"}`,
			);
		}

		proposal.status = "approved";
		proposal.approvedBy = approverId;
		proposal.approvedAt = new Date().toISOString();

		// Add to backlog
		this.addToBacklog(proposal);

		// Add to group pulse
		this.addPulseEntry({
			agentId: approverId,
			type: "review",
			content: `Approved: ${proposal.title} (${proposalId})`,
			relatedId: proposalId,
		});

		return proposal;
	}

	/**
	 * Reject a proposal.
	 */
	rejectProposal(
		proposalId: string,
		rejectorId: string,
		reason: string,
	): Proposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		proposal.status = "rejected";
		proposal.rejectedBy = rejectorId;
		proposal.rejectedAt = new Date().toISOString();
		proposal.rejectionReason = reason;

		this.addPulseEntry({
			agentId: rejectorId,
			type: "review",
			content: `Rejected: ${proposal.title} (${proposalId}) - ${reason}`,
			relatedId: proposalId,
		});

		return proposal;
	}

	/**
	 * Get approval info for a proposal (proposer, approver, timestamp).
	 */
	getApprovalInfo(proposalId: string): {
		proposalId: string;
		proposedBy: string;
		proposedAt: string;
		approvedBy?: string;
		approvedAt?: string;
		reviews: ProposalReview[];
	} | null {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) return null;

		return {
			proposalId,
			proposedBy: proposal.proposedBy,
			proposedAt: proposal.proposedAt,
			approvedBy: proposal.approvedBy,
			approvedAt: proposal.approvedAt,
			reviews: this.reviews.get(proposalId) || [],
		};
	}

	// ─── AC#4: Lease Management ────────────────────────────────────

	/**
	 * Lease a backlog item for a time window.
	 */
	leaseItem(
		itemId: string,
		agentId: string,
		options?: {
			durationMs?: number;
			heartbeatToken?: string;
			reason?: string;
		},
	): Lease {
		const item = this.backlog.get(itemId);
		if (!item) {
			throw new Error(`Backlog item not found: ${itemId}`);
		}

		if (item.status === "leased") {
			throw new Error(`Item ${itemId} is already leased`);
		}

		if (item.status === "completed") {
			throw new Error(`Item ${itemId} is already completed`);
		}

		const durationMs = options?.durationMs || DEFAULT_LEASE_DURATION_MS;
		const now = new Date();

		const lease: Lease = {
			leaseId: `LEASE-${randomUUID().slice(0, 8)}`,
			proposalId: item.proposalId,
			agentId,
			grantedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + durationMs).toISOString(),
			status: "active",
			heartbeatToken:
				options?.heartbeatToken || this.generateHeartbeatToken(agentId),
			renewalCount: 0,
			maxRenewals: DEFAULT_MAX_RENEWALS,
			leaseReason: options?.reason,
		};

		this.leases.set(lease.leaseId, lease);

		// Update backlog item
		item.status = "leased";
		item.currentLeaseId = lease.leaseId;
		item.leaseHistory.push(lease.leaseId);

		this.addPulseEntry({
			agentId,
			type: "lease",
			content: `Leased: ${item.title} (${itemId}) for ${durationMs / 3600000}h`,
			relatedId: lease.leaseId,
		});

		return lease;
	}

	// ─── AC#5: Automatic Lease Expiry ──────────────────────────────

	/**
	 * Check and expire leases that have passed their expiry time.
	 */
	checkExpiredLeases(): Lease[] {
		const now = new Date();
		const expiredLeases: Lease[] = [];

		for (const lease of this.leases.values()) {
			if (lease.status === "active" && new Date(lease.expiresAt) < now) {
				lease.status = "expired";
				lease.releasedAt = now.toISOString();
				lease.releaseReason = "Lease expired";

				// Update backlog item
				const item = Array.from(this.backlog.values()).find(
					(i) => i.currentLeaseId === lease.leaseId,
				);
				if (item) {
					item.status = "available";
					item.currentLeaseId = undefined;
				}

				expiredLeases.push(lease);

				this.addPulseEntry({
					agentId: lease.agentId,
					type: "release",
					content: `Lease expired: ${lease.leaseId} (proposal: ${lease.proposalId})`,
					relatedId: lease.leaseId,
				});
			}
		}

		return expiredLeases;
	}

	/**
	 * Start the background expiry checker.
	 */
	private startExpiryChecker(): void {
		if (this.expiryCheckInterval) return;

		this.expiryCheckInterval = setInterval(() => {
			this.checkExpiredLeases();
		}, LEASE_EXPIRY_CHECK_INTERVAL_MS);
	}

	// ─── AC#6: Heartbeat-Based Lease Renewal ───────────────────────

	/**
	 * Renew a lease using heartbeat proof.
	 */
	renewLease(proof: LeaseRenewalProof): Lease {
		const lease = this.leases.get(proof.leaseId);
		if (!lease) {
			throw new Error(`Lease not found: ${proof.leaseId}`);
		}

		if (lease.status !== "active") {
			throw new Error(`Cannot renew lease in status: ${lease.status}`);
		}

		if (lease.agentId !== proof.agentId) {
			throw new Error(
				`Agent ${proof.agentId} does not own lease ${proof.leaseId}`,
			);
		}

		if (lease.renewalCount >= lease.maxRenewals) {
			throw new Error(
				`Maximum renewals (${lease.maxRenewals}) reached for lease ${proof.leaseId}`,
			);
		}

		// Validate heartbeat proof
		if (!this.validateHeartbeatProof(lease, proof)) {
			throw new Error("Invalid heartbeat proof");
		}

		// Renew: extend expiry by another default duration
		const now = new Date();
		lease.expiresAt = new Date(
			now.getTime() + DEFAULT_LEASE_DURATION_MS,
		).toISOString();
		lease.lastHeartbeat = now.toISOString();
		lease.renewalCount++;

		// Update heartbeat token for next renewal
		lease.heartbeatToken = this.generateHeartbeatToken(lease.agentId);

		this.addPulseEntry({
			agentId: proof.agentId,
			type: "lease",
			content: `Renewed lease ${proof.leaseId} (renewal ${lease.renewalCount}/${lease.maxRenewals})`,
			relatedId: proof.leaseId,
		});

		return lease;
	}

	/**
	 * Generate a heartbeat token for an agent.
	 */
	private generateHeartbeatToken(agentId: string): string {
		const timestamp = Date.now().toString();
		const nonce = randomUUID();
		return createHash("sha256")
			.update(`${agentId}:${timestamp}:${nonce}`)
			.digest("hex");
	}

	/**
	 * Validate a heartbeat proof.
	 */
	private validateHeartbeatProof(
		lease: Lease,
		proof: LeaseRenewalProof,
	): boolean {
		// Basic validation: agent ID matches and timestamp is recent
		if (proof.agentId !== lease.agentId) return false;

		const proofTime = new Date(proof.timestamp).getTime();
		const now = Date.now();
		const maxAge = 5 * 60 * 1000; // 5 minutes

		if (now - proofTime > maxAge) return false;

		// Hash should contain agent ID and nonce
		const expectedHash = createHash("sha256")
			.update(`${proof.agentId}:${proof.timestamp}:${proof.nonce}`)
			.digest("hex");

		return proof.heartbeatHash === expectedHash;
	}

	/**
	 * Submit a heartbeat to keep a lease alive (direct method).
	 */
	submitHeartbeat(leaseId: string, agentId: string): Lease {
		const lease = this.leases.get(leaseId);
		if (!lease) {
			throw new Error(`Lease not found: ${leaseId}`);
		}

		if (lease.agentId !== agentId) {
			throw new Error(`Agent ${agentId} does not own lease ${leaseId}`);
		}

		if (lease.status !== "active") {
			throw new Error(`Cannot heartbeat lease in status: ${lease.status}`);
		}

		lease.lastHeartbeat = new Date().toISOString();
		return lease;
	}

	// ─── AC#7: Group Pulse Tracking ────────────────────────────────

	/**
	 * Add an entry to the group pulse.
	 */
	private addPulseEntry(options: {
		agentId: string;
		type: "proposal" | "comment" | "review" | "lease" | "release";
		content: string;
		relatedId?: string;
	}): GroupPulseEntry {
		const entry: GroupPulseEntry = {
			entryId: `PULSE-${randomUUID().slice(0, 8)}`,
			agentId: options.agentId,
			type: options.type,
			content: options.content,
			timestamp: new Date().toISOString(),
			relatedId: options.relatedId,
		};

		this.groupPulse.push(entry);
		return entry;
	}

	/**
	 * Get group pulse entries (optionally filtered).
	 */
	getGroupPulse(options?: {
		agentId?: string;
		type?: string;
		since?: string;
		limit?: number;
	}): GroupPulseEntry[] {
		let entries = [...this.groupPulse];

		if (options?.agentId) {
			entries = entries.filter((e) => e.agentId === options.agentId);
		}
		if (options?.type) {
			entries = entries.filter((e) => e.type === options.type);
		}
		if (options?.since) {
			entries = entries.filter((e) => e.timestamp >= options?.since!);
		}

		entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		if (options?.limit) {
			entries = entries.slice(0, options.limit);
		}

		return entries;
	}

	// ─── Backlog Management ────────────────────────────────────────

	/**
	 * Add an approved proposal to the backlog.
	 */
	private addToBacklog(proposal: Proposal): BacklogItem {
		const item: BacklogItem = {
			itemId: `BKLOG-${randomUUID().slice(0, 8)}`,
			proposalId: proposal.proposalId,
			title: proposal.title,
			description: proposal.description,
			addedBy: proposal.approvedBy || proposal.proposedBy,
			addedAt: new Date().toISOString(),
			tags: proposal.tags,
			priority: proposal.priority,
			status: "available",
			leaseHistory: [],
		};

		this.backlog.set(item.itemId, item);
		return item;
	}

	/**
	 * Get available backlog items.
	 */
	getAvailableBacklog(options?: {
		tags?: string[];
		priority?: string;
		limit?: number;
	}): BacklogItem[] {
		let items = Array.from(this.backlog.values()).filter(
			(i) => i.status === "available",
		);

		if (options?.tags) {
			items = items.filter((i) =>
				options.tags?.some((t) => i.tags.includes(t)),
			);
		}
		if (options?.priority) {
			items = items.filter((i) => i.priority === options.priority);
		}

		// Sort by priority then date
		const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
		items.sort((a, b) => {
			const pDiff =
				(priorityOrder[a.priority] || 4) - (priorityOrder[b.priority] || 4);
			if (pDiff !== 0) return pDiff;
			return a.addedAt.localeCompare(b.addedAt);
		});

		if (options?.limit) {
			items = items.slice(0, options.limit);
		}

		return items;
	}

	/**
	 * Get a backlog item by ID.
	 */
	getBacklogItem(itemId: string): BacklogItem | null {
		return this.backlog.get(itemId) ?? null;
	}

	/**
	 * Release a lease early.
	 */
	releaseLease(leaseId: string, agentId: string, reason?: string): Lease {
		const lease = this.leases.get(leaseId);
		if (!lease) {
			throw new Error(`Lease not found: ${leaseId}`);
		}

		if (lease.agentId !== agentId) {
			throw new Error(`Agent ${agentId} does not own lease ${leaseId}`);
		}

		lease.status = "released";
		lease.releasedAt = new Date().toISOString();
		lease.releaseReason = reason || "Released by agent";

		// Update backlog item
		const item = Array.from(this.backlog.values()).find(
			(i) => i.currentLeaseId === leaseId,
		);
		if (item) {
			item.status = "available";
			item.currentLeaseId = undefined;
		}

		this.addPulseEntry({
			agentId,
			type: "release",
			content: `Released lease ${leaseId}: ${reason || "early release"}`,
			relatedId: leaseId,
		});

		return lease;
	}

	// ─── Query Methods ─────────────────────────────────────────────

	/**
	 * Get a proposal by ID.
	 */
	getProposal(proposalId: string): Proposal | null {
		return this.proposals.get(proposalId) ?? null;
	}

	/**
	 * Get a proposal by proposal ID.
	 */
	getProposalByProposal(proposalId: string): Proposal | null {
		return (
			Array.from(this.proposals.values()).find(
				(p) => p.proposalId === proposalId,
			) ?? null
		);
	}

	/**
	 * Get proposals by status.
	 */
	getProposalsByStatus(status: ProposalStatus): Proposal[] {
		return Array.from(this.proposals.values()).filter(
			(p) => p.status === status,
		);
	}

	/**
	 * Get all proposals.
	 */
	getAllProposals(): Proposal[] {
		return Array.from(this.proposals.values());
	}

	/**
	 * Get reviews for a proposal.
	 */
	getProposalReviews(proposalId: string): ProposalReview[] {
		return this.reviews.get(proposalId) || [];
	}

	/**
	 * Get a lease by ID.
	 */
	getLease(leaseId: string): Lease | null {
		return this.leases.get(leaseId) ?? null;
	}

	/**
	 * Get active leases for an agent.
	 */
	getAgentLeases(agentId: string): Lease[] {
		return Array.from(this.leases.values()).filter(
			(l) => l.agentId === agentId && l.status === "active",
		);
	}

	/**
	 * Get all active leases.
	 */
	getActiveLeases(): Lease[] {
		return Array.from(this.leases.values()).filter(
			(l) => l.status === "active",
		);
	}

	/**
	 * Get statistics.
	 */
	getStats(): {
		totalProposals: number;
		proposed: number;
		inReview: number;
		approved: number;
		rejected: number;
		backlogAvailable: number;
		backlogLeased: number;
		activeLeases: number;
		totalPulseEntries: number;
	} {
		const proposals = Array.from(this.proposals.values());
		const items = Array.from(this.backlog.values());
		const leases = Array.from(this.leases.values());

		return {
			totalProposals: proposals.length,
			proposed: proposals.filter((p) => p.status === "proposed").length,
			inReview: proposals.filter((p) => p.status === "in-review").length,
			approved: proposals.filter((p) => p.status === "approved").length,
			rejected: proposals.filter((p) => p.status === "rejected").length,
			backlogAvailable: items.filter((i) => i.status === "available").length,
			backlogLeased: items.filter((i) => i.status === "leased").length,
			activeLeases: leases.filter((l) => l.status === "active").length,
			totalPulseEntries: this.groupPulse.length,
		};
	}

	// ─── Persistence ───────────────────────────────────────────────

	/**
	 * Save proposal to disk.
	 */
	async saveProposal(): Promise<void> {
		const proposal = {
			proposals: Array.from(this.proposals.entries()),
			reviews: Array.from(this.reviews.entries()),
			leases: Array.from(this.leases.entries()),
			backlog: Array.from(this.backlog.entries()),
			groupPulse: this.groupPulse,
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

			this.proposals = new Map(proposal.proposals || []);
			this.reviews = new Map(proposal.reviews || []);
			this.leases = new Map(proposal.leases || []);
			this.backlog = new Map(proposal.backlog || []);
			this.groupPulse = proposal.groupPulse || [];
		} catch {
			// No proposal yet
		}
	}
}

// ─── Convenience Functions ──────────────────────────────────────────

/**
 * Create a heartbeat renewal proof.
 */
export function createHeartbeatProof(
	leaseId: string,
	agentId: string,
): LeaseRenewalProof {
	const timestamp = new Date().toISOString();
	const nonce = randomUUID();
	const heartbeatHash = createHash("sha256")
		.update(`${agentId}:${timestamp}:${nonce}`)
		.digest("hex");

	return {
		leaseId,
		agentId,
		heartbeatHash,
		timestamp,
		nonce,
	};
}

/**
 * Validate a proposal title format.
 */
export function isValidProposalTitle(title: string): boolean {
	return title.length >= 3 && title.length <= 200;
}

/**
 * Generate a proposal template.
 */
export function generateProposalTemplate(
	proposalId: string,
	title: string,
	proposedBy: string,
): string {
	return `# Proposal: ${title}

## Proposal Reference
- **Proposal ID**: ${proposalId}
- **Proposed By**: ${proposedBy}
- **Date**: ${new Date().toISOString().split("T")[0]}

## Problem Proposalment
[What problem does this solve?]

## Proposed Solution
[How will this be implemented?]

## Acceptance Criteria
- [ ] AC#1: [First criterion]
- [ ] AC#2: [Second criterion]

## Dependencies
[List any dependencies on other proposals or components]

## Estimated Effort
[XS|S|M|L|XL]
`;
}
