/**
 * STATE-61: Agent Proposal & Lease-Based Backlog System
 *
 * Extends the proposal workflow with:
 * - Leasable backlog items with configurable time windows
 * - Auto-release on lease expiration
 * - Heartbeat proof for lease renewal (connects to STATE-7)
 * - MCP tool for proposals and lease management
 * - Integration with agent registry for attribution
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
/** Status of a proposal record in the lease-backlog system */
export type LeaseProposalStatus = "Proposed" | "Approved" | "Rejected" | "Under Review";

/** Review record for a proposal */
export interface Review {
	reviewer: string;
	role: "pm" | "architect";
	decision: "approved" | "rejected" | "changes_requested";
	comments: string;
	timestamp: string;
}

/** Lease status */
export type LeaseStatus = "available" | "leased" | "expired" | "completed";

/** Lease record for a backlog item */
export interface Lease {
	proposalId: string;
	agentId: string;
	agentName: string;
	leasedAt: string;
	expiresAt: string;
	renewedCount: number;
	lastHeartbeat?: string;
	status: LeaseStatus;
	notes: string;
}

/** Backlog item - approved proposal ready for work */
export interface BacklogItem {
	proposalId: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	approvedBy: string;
	approvedDate: string;
	addedToBacklogDate: string;
	priority: "low" | "medium" | "high" | "critical";
	estimatedEffort?: string;
	dependencies: string[];
	lease?: Lease;
	status: LeaseStatus;
}

/** Proposal record for tracking */
export interface ProposalRecord {
	proposalId: string;
	title: string;
	proposer: string;
	proposedAt: string;
	status: LeaseProposalStatus;
	approvedBy?: string;
	approvedAt?: string;
	addedToBacklogAt?: string;
	reviews: Review[];
	notes: string;
}

/** Heartbeat proof for lease renewal */
export interface HeartbeatProof {
	agentId: string;
	timestamp: string;
	nonce: string;
	workProgress: string;
	proposalsCompleted: string[];
	proofHash: string;
}

/** Configuration for the lease system */
export interface LeaseConfig {
	/** Default lease duration in hours (default: 48) */
	defaultLeaseHours: number;
	/** Maximum lease renewals (default: 3) */
	maxRenewals: number;
	/** Minimum heartbeat interval in minutes (default: 60) */
	heartbeatIntervalMinutes: number;
	/** Require heartbeat proof for renewal */
	requireHeartbeatProof: boolean;
	/** Auto-expire leases without heartbeat */
	autoExpireNoHeartbeat: boolean;
	/** Storage directory for backlog data */
	storageDir: string;
}

/** Default lease configuration */
export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
	defaultLeaseHours: 48,
	maxRenewals: 3,
	heartbeatIntervalMinutes: 60,
	requireHeartbeatProof: true,
	autoExpireNoHeartbeat: true,
	storageDir: "roadmap/backlog",
};

/**
 * Lease-Based Backlog Manager
 *
 * Manages approved proposals as leasable backlog items with time-based leases.
 */
export class LeaseBacklogManager {
	private config: LeaseConfig;
	private backlog: Map<string, BacklogItem> = new Map();
	private proposals: Map<string, ProposalRecord> = new Map();
	private leaseHistory: Map<string, Lease[]> = new Map();
	private storagePath: string;

	constructor(config: Partial<LeaseConfig> = {}) {
		this.config = { ...DEFAULT_LEASE_CONFIG, ...config };
		this.storagePath = config.storageDir || DEFAULT_LEASE_CONFIG.storageDir;
		this.ensureStorageDir();
	}

	private ensureStorageDir(): void {
		if (!existsSync(this.storagePath)) {
			mkdirSync(this.storagePath, { recursive: true });
		}
	}

	/**
	 * Submit a new proposal
	 */
	submitProposal(
		proposalId: string,
		title: string,
		proposer: string,
		_description: string,
		_acceptanceCriteria: string[],
		_priority: BacklogItem["priority"] = "medium",
	): ProposalRecord {
		// Validate proposalId format
		if (!proposalId.match(/^(STATE-\d+(\.\d+)?|proposal-\d+|P\d+)$/)) {
			throw new Error(
				`Invalid proposal ID format: ${proposalId}. Expected STATE-<number>, proposal-<number>, or P<number>`,
			);
		}

		// Check if proposal already exists
		if (this.proposals.has(proposalId)) {
			throw new Error(`Proposal already exists for ${proposalId}`);
		}

		const proposal: ProposalRecord = {
			proposalId,
			title,
			proposer,
			proposedAt: new Date().toISOString(),
			status: "Proposed",
			reviews: [],
			notes: `Proposed by ${proposer}`,
		};

		this.proposals.set(proposalId, proposal);
		this.saveProposal(proposal);

		return proposal;
	}

	/**
	 * Add a review to a proposal
	 */
	addReview(
		proposalId: string,
		reviewer: string,
		role: "pm" | "architect",
		decision: "approved" | "rejected" | "changes_requested",
		comments: string,
	): ProposalRecord {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`No proposal found for ${proposalId}`);
		}

		const review: Review = {
			reviewer,
			role,
			decision,
			comments,
			timestamp: new Date().toISOString(),
		};

		proposal.reviews.push(review);

		// Check if approved by both PM and Architect
		const hasPmApproval = proposal.reviews.some(
			(r) => r.role === "pm" && r.decision === "approved",
		);
		const hasArchitectApproval = proposal.reviews.some(
			(r) => r.role === "architect" && r.decision === "approved",
		);

		if (hasPmApproval && hasArchitectApproval) {
			proposal.status = "Approved";
			proposal.approvedBy = [reviewer].join(", ");
			proposal.approvedAt = review.timestamp;
		} else if (proposal.reviews.some((r) => r.decision === "rejected")) {
			proposal.status = "Rejected";
		} else {
			proposal.status = "Under Review";
		}

		this.proposals.set(proposalId, proposal);
		this.saveProposal(proposal);

		return proposal;
	}

	/**
	 * Add approved proposal to backlog
	 */
	addToBacklog(
		proposalId: string,
		description: string,
		acceptanceCriteria: string[],
		priority: BacklogItem["priority"] = "medium",
		estimatedEffort?: string,
		dependencies: string[] = [],
	): BacklogItem {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) {
			throw new Error(`No proposal found for ${proposalId}`);
		}

		if (proposal.status !== "Approved") {
			throw new Error(
				`Proposal ${proposalId} is not approved (status: ${proposal.status})`,
			);
		}

		if (this.backlog.has(proposalId)) {
			throw new Error(`Backlog item already exists for ${proposalId}`);
		}

		const item: BacklogItem = {
			proposalId,
			title: proposal.title,
			description,
			acceptanceCriteria,
			approvedBy: proposal.approvedBy || "unknown",
			approvedDate: proposal.approvedAt || new Date().toISOString(),
			addedToBacklogDate: new Date().toISOString(),
			priority,
			estimatedEffort,
			dependencies,
			status: "available",
		};

		this.backlog.set(proposalId, item);
		proposal.addedToBacklogAt = item.addedToBacklogDate;
		this.saveBacklogItem(item);
		this.saveProposal(proposal);

		return item;
	}

	/**
	 * Lease a backlog item
	 */
	leaseItem(
		proposalId: string,
		agentId: string,
		agentName: string,
		leaseHours?: number,
		notes: string = "",
	): Lease {
		const item = this.backlog.get(proposalId);
		if (!item) {
			throw new Error(`No backlog item found for ${proposalId}`);
		}

		// Check if already leased
		if (item.status === "leased" && item.lease) {
			const leaseExpiry = new Date(item.lease.expiresAt);
			if (leaseExpiry > new Date()) {
				throw new Error(
					`Backlog item ${proposalId} is already leased to ${item.lease.agentName} until ${item.lease.expiresAt}`,
				);
			}
			// Lease expired, allow re-lease
		}

		// Check if dependencies are all completed
		const unmetDeps = this.checkDependencies(proposalId, item.dependencies);
		if (unmetDeps.length > 0) {
			throw new Error(
				`Cannot lease ${proposalId}: unmet dependencies: ${unmetDeps.join(", ")}`,
			);
		}

		const duration = leaseHours || this.config.defaultLeaseHours;
		const now = new Date();
		const expiresAt = new Date(now.getTime() + duration * 60 * 60 * 1000);

		const lease: Lease = {
			proposalId,
			agentId,
			agentName,
			leasedAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			renewedCount: 0,
			status: "leased",
			notes,
		};

		item.lease = lease;
		item.status = "leased";

		// Track lease history
		const history = this.leaseHistory.get(proposalId) || [];
		history.push(lease);
		this.leaseHistory.set(proposalId, history);

		this.backlog.set(proposalId, item);
		this.saveBacklogItem(item);

		return lease;
	}

	/**
	 * Renew a lease with heartbeat proof
	 */
	renewLease(
		proposalId: string,
		agentId: string,
		heartbeatProof?: HeartbeatProof,
	): Lease {
		const item = this.backlog.get(proposalId);
		if (!item) {
			throw new Error(`No backlog item found for ${proposalId}`);
		}

		if (!item.lease) {
			throw new Error(`No active lease for ${proposalId}`);
		}

		if (item.lease.agentId !== agentId) {
			throw new Error(
				`Lease for ${proposalId} belongs to ${item.lease.agentId}, not ${agentId}`,
			);
		}

		// Check heartbeat proof if required
		if (this.config.requireHeartbeatProof) {
			if (!heartbeatProof) {
				throw new Error("Heartbeat proof required for lease renewal");
			}
			if (!this.validateHeartbeatProof(heartbeatProof)) {
				throw new Error("Invalid heartbeat proof");
			}
		}

		// Check max renewals
		if (item.lease.renewedCount >= this.config.maxRenewals) {
			throw new Error(
				`Maximum renewals (${this.config.maxRenewals}) reached for ${proposalId}`,
			);
		}

		// Extend lease
		const now = new Date();
		const currentExpiry = new Date(item.lease.expiresAt);
		const newExpiry = new Date(
			Math.max(currentExpiry.getTime(), now.getTime()) +
				this.config.defaultLeaseHours * 60 * 60 * 1000,
		);

		item.lease.expiresAt = newExpiry.toISOString();
		item.lease.renewedCount++;
		item.lease.lastHeartbeat = now.toISOString();
		item.lease.status = "leased";

		this.backlog.set(proposalId, item);
		this.saveBacklogItem(item);

		return item.lease;
	}

	/**
	 * Release a lease early (agent gives up)
	 */
	releaseLease(
		proposalId: string,
		agentId: string,
		reason: string = "",
	): BacklogItem {
		const item = this.backlog.get(proposalId);
		if (!item) {
			throw new Error(`No backlog item found for ${proposalId}`);
		}

		if (!item.lease) {
			throw new Error(`No active lease for ${proposalId}`);
		}

		if (item.lease.agentId !== agentId) {
			throw new Error(
				`Lease for ${proposalId} belongs to ${item.lease.agentId}, not ${agentId}`,
			);
		}

		item.lease.status = "expired";
		item.status = "available";
		item.lease.notes += ` | Released early: ${reason}`;

		this.backlog.set(proposalId, item);
		this.saveBacklogItem(item);

		return item;
	}

	/**
	 * Complete a backlog item (work finished)
	 */
	completeItem(proposalId: string, agentId: string): BacklogItem {
		const item = this.backlog.get(proposalId);
		if (!item) {
			throw new Error(`No backlog item found for ${proposalId}`);
		}

		if (item.lease && item.lease.agentId !== agentId) {
			throw new Error(
				`Lease for ${proposalId} belongs to ${item.lease.agentId}, not ${agentId}`,
			);
		}

		if (item.lease) {
			item.lease.status = "completed";
		}
		item.status = "completed";

		this.backlog.set(proposalId, item);
		this.saveBacklogItem(item);

		return item;
	}

	/**
	 * Check and expire stale leases
	 */
	expireStaleLeases(): BacklogItem[] {
		const now = new Date();
		const expired: BacklogItem[] = [];

		for (const [proposalId, item] of this.backlog) {
			if (item.status === "leased" && item.lease) {
				const expiry = new Date(item.lease.expiresAt);
				if (expiry <= now) {
					item.lease.status = "expired";
					item.status = "available";
					this.backlog.set(proposalId, item);
					this.saveBacklogItem(item);
					expired.push(item);
				}
			}
		}

		return expired;
	}

	/**
	 * Validate heartbeat proof
	 */
	validateHeartbeatProof(proof: HeartbeatProof): boolean {
		// Basic validation
		if (!proof.agentId || !proof.timestamp || !proof.nonce) {
			return false;
		}

		// Check timestamp is recent (within 2x heartbeat interval)
		const proofTime = new Date(proof.timestamp);
		const now = new Date();
		const maxAge = this.config.heartbeatIntervalMinutes * 2 * 60 * 1000;
		if (now.getTime() - proofTime.getTime() > maxAge) {
			return false;
		}

		// Verify proof hash
		const expectedHash = createHash("sha256")
			.update(`${proof.agentId}:${proof.timestamp}:${proof.nonce}`)
			.digest("hex");

		return proof.proofHash === expectedHash;
	}

	/**
	 * Generate heartbeat proof for an agent
	 */
	generateHeartbeatProof(
		agentId: string,
		workProgress: string,
		proposalsCompleted: string[],
	): HeartbeatProof {
		const timestamp = new Date().toISOString();
		const nonce = createHash("sha256")
			.update(`${agentId}:${timestamp}:${Math.random()}`)
			.digest("hex")
			.slice(0, 16);

		const proofHash = createHash("sha256")
			.update(`${agentId}:${timestamp}:${nonce}`)
			.digest("hex");

		return {
			agentId,
			timestamp,
			nonce,
			workProgress,
			proposalsCompleted,
			proofHash,
		};
	}

	/**
	 * Check if dependencies are completed
	 */
	checkDependencies(_proposalId: string, dependencies: string[]): string[] {
		const unmet: string[] = [];

		for (const dep of dependencies) {
			const depItem = this.backlog.get(dep);
			if (!depItem || depItem.status !== "completed") {
				unmet.push(dep);
			}
		}

		return unmet;
	}

	/**
	 * Get all available (unleased) backlog items
	 */
	getAvailableItems(): BacklogItem[] {
		this.expireStaleLeases();
		return Array.from(this.backlog.values()).filter(
			(item) => item.status === "available",
		);
	}

	/**
	 * Get all leased items
	 */
	getLeasedItems(): BacklogItem[] {
		return Array.from(this.backlog.values()).filter(
			(item) => item.status === "leased",
		);
	}

	/**
	 * Get items by priority
	 */
	getItemsByPriority(priority: BacklogItem["priority"]): BacklogItem[] {
		return Array.from(this.backlog.values()).filter(
			(item) => item.priority === priority,
		);
	}

	/**
	 * Get proposals by status
	 */
	getProposalsByStatus(status: LeaseProposalStatus): ProposalRecord[] {
		return Array.from(this.proposals.values()).filter(
			(p) => p.status === status,
		);
	}

	/**
	 * Get lease history for a proposal
	 */
	getLeaseHistory(proposalId: string): Lease[] {
		return this.leaseHistory.get(proposalId) || [];
	}

	/**
	 * Get backlog statistics
	 */
	getStats(): {
		totalProposals: number;
		pendingReview: number;
		approved: number;
		rejected: number;
		totalBacklog: number;
		available: number;
		leased: number;
		completed: number;
		expiringSoon: number;
	} {
		const proposals = Array.from(this.proposals.values());
		const items = Array.from(this.backlog.values());
		const now = new Date();
		const oneDayMs = 24 * 60 * 60 * 1000;

		return {
			totalProposals: proposals.length,
			pendingReview: proposals.filter(
				(p) => p.status === "Under Review" || p.status === "Proposed",
			).length,
			approved: proposals.filter((p) => p.status === "Approved").length,
			rejected: proposals.filter((p) => p.status === "Rejected").length,
			totalBacklog: items.length,
			available: items.filter((i) => i.status === "available").length,
			leased: items.filter((i) => i.status === "leased").length,
			completed: items.filter((i) => i.status === "completed").length,
			expiringSoon: items.filter((i) => {
				if (i.status !== "leased" || !i.lease) return false;
				const expiry = new Date(i.lease.expiresAt);
				return expiry.getTime() - now.getTime() < oneDayMs;
			}).length,
		};
	}

	/**
	 * Get a summary of the backlog for display
	 */
	getSummary(): string {
		const stats = this.getStats();
		const lines: string[] = [
			"Backlog Summary",
			"===============",
			`Proposals: ${stats.totalProposals} total (${stats.pendingReview} pending, ${stats.approved} approved, ${stats.rejected} rejected)`,
			`Backlog: ${stats.totalBacklog} items (${stats.available} available, ${stats.leased} leased, ${stats.completed} completed)`,
			`Expiring Soon: ${stats.expiringSoon}`,
		];

		// List leased items
		const leased = this.getLeasedItems();
		if (leased.length > 0) {
			lines.push("\nCurrently Leased:");
			for (const item of leased) {
				lines.push(
					`  - ${item.proposalId}: ${item.title} (by ${item.lease?.agentName}, expires ${item.lease?.expiresAt})`,
				);
			}
		}

		// List available items by priority
		const available = this.getAvailableItems();
		if (available.length > 0) {
			lines.push("\nAvailable (by priority):");
			const byPriority = available.sort((a, b) => {
				const order = { critical: 0, high: 1, medium: 2, low: 3 };
				return order[a.priority] - order[b.priority];
			});
			for (const item of byPriority) {
				lines.push(`  - [${item.priority}] ${item.proposalId}: ${item.title}`);
			}
		}

		return lines.join("\n");
	}

	// --- Persistence ---

	private saveProposal(proposal: ProposalRecord): void {
		const filePath = join(
			this.storagePath,
			`proposal-${proposal.proposalId}.json`,
		);
		writeFileSync(filePath, JSON.stringify(proposal, null, 2));
	}

	private saveBacklogItem(item: BacklogItem): void {
		const filePath = join(this.storagePath, `backlog-${item.proposalId}.json`);
		writeFileSync(filePath, JSON.stringify(item, null, 2));
	}

	/**
	 * Load persisted data from disk
	 */
	loadFromDisk(): void {
		if (!existsSync(this.storagePath)) return;

		const files = readdirSync(this.storagePath);

		for (const file of files) {
			if (file.startsWith("proposal-") && file.endsWith(".json")) {
				const data = readFileSync(join(this.storagePath, file), "utf-8");
				const proposal: ProposalRecord = JSON.parse(data);
				this.proposals.set(proposal.proposalId, proposal);
			}
			if (file.startsWith("backlog-") && file.endsWith(".json")) {
				const data = readFileSync(join(this.storagePath, file), "utf-8");
				const item: BacklogItem = JSON.parse(data);
				this.backlog.set(item.proposalId, item);
			}
		}
	}

	/**
	 * Clear all data (for testing)
	 */
	clear(): void {
		this.proposals.clear();
		this.backlog.clear();
		this.leaseHistory.clear();
	}

	/**
	 * Get a specific backlog item
	 */
	getItem(proposalId: string): BacklogItem | undefined {
		return this.backlog.get(proposalId);
	}

	/**
	 * Get a specific proposal
	 */
	getProposal(proposalId: string): ProposalRecord | undefined {
		return this.proposals.get(proposalId);
	}

	/**
	 * List all backlog items
	 */
	listAll(): BacklogItem[] {
		return Array.from(this.backlog.values());
	}

	/**
	 * List all proposals
	 */
	listProposals(): ProposalRecord[] {
		return Array.from(this.proposals.values());
	}

	/**
	 * Remove a proposal (only if not in backlog)
	 */
	removeProposal(proposalId: string): boolean {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) return false;
		if (this.backlog.has(proposalId)) {
			throw new Error(
				`Cannot remove proposal ${proposalId} - exists in backlog`,
			);
		}
		this.proposals.delete(proposalId);
		const filePath = join(this.storagePath, `proposal-${proposalId}.json`);
		if (existsSync(filePath)) unlinkSync(filePath);
		return true;
	}

	/**
	 * Remove a backlog item (only if not leased)
	 */
	removeBacklogItem(proposalId: string): boolean {
		const item = this.backlog.get(proposalId);
		if (!item) return false;
		if (item.status === "leased") {
			throw new Error(
				`Cannot remove backlog item ${proposalId} - currently leased`,
			);
		}
		this.backlog.delete(proposalId);
		const filePath = join(this.storagePath, `backlog-${proposalId}.json`);
		if (existsSync(filePath)) unlinkSync(filePath);
		return true;
	}
}
