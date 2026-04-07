/**
 * STATE-61: Agent Proposal & Lease-Based Backlog System
 *
 * Extends STATE-4 (lease-based proposal claiming) with an agent proposal system.
 * Agents propose solutions before claiming work, ensuring quality and
 * reducing duplicate effort in multi-agent teams.
 *
 * AC#1: Agent can submit a proposal for a proposal
 * AC#2: Proposal includes implementation approach + estimated complexity
 * AC#3: Proposal review workflow (Pending → Approved → Rejected)
 * AC#4: Only approved proposals can claim the proposal (lease)
 * AC#5: Proposal feedback visible to all agents (learning signal)
 * AC#6: Proposal history preserved for retrospective analysis
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────

/** Proposal workflow status */
export type ProposalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "withdrawn"
	| "expired";

/** Complexity levels for effort estimation */
export type ComplexityLevel =
	| "trivial"
	| "low"
	| "medium"
	| "high"
	| "very-high";

/** Implementation approach types */
export type ApproachType =
	| "incremental"
	| "rewrite"
	| "new-feature"
	| "refactor"
	| "fix";

/** Individual feedback item from review */
export interface ProposalFeedbackItem {
	/** Feedback category */
	category: "approach" | "complexity" | "scope" | "risk" | "general";
	/** Feedback content */
	content: string;
	/** Suggested improvement (optional) */
	suggestion?: string;
	/** Severity of the feedback */
	severity: "info" | "warning" | "blocker";
}

/** Implementation approach submitted with proposal */
export interface ImplementationApproach {
	/** Type of approach */
	type: ApproachType;
	/** Detailed description of the approach */
	description: string;
	/** Key files/modules to be modified */
	filesAffected: string[];
	/** Dependencies to be added/modified */
	dependencies: string[];
	/** Estimated timeline (human-readable) */
	estimatedTimeline: string;
	/** Testing strategy */
	testingStrategy: string;
	/** Risk assessment */
	risks: string[];
	/** Rollback plan */
	rollbackPlan?: string;
}

/** Complexity estimate for the proposal */
export interface ComplexityEstimate {
	/** Complexity level */
	level: ComplexityLevel;
	/** Numeric score (1-10) for easier comparison */
	score: number;
	/** Breakdown of sub-tasks */
	tasks: ComplexTask[];
	/** Total estimated hours */
	estimatedHours?: number;
	/** Confidence in estimate (0-1) */
	confidence: number;
}

/** Individual task within a complexity estimate */
export interface ComplexTask {
	/** Task description */
	description: string;
	/** Estimated complexity for this task */
	level: ComplexityLevel;
	/** Dependencies on other tasks */
	dependsOn: number[]; // indices into tasks array
}

/** Proposal from an agent */
export interface AgentProposal {
	/** Unique proposal ID */
	proposalId: string;
	/** Proposal this proposal targets */
	targetProposalId: string;
	/** Proposing agent */
	agentId: string;
	/** Proposal title */
	title: string;
	/** Summary of the proposed solution */
	summary: string;
	/** Implementation approach */
	approach: ImplementationApproach;
	/** Complexity estimate */
	complexity: ComplexityEstimate;
	/** Current status */
	status: ProposalStatus;
	/** When submitted */
	submittedAt: string;
	/** When last updated */
	updatedAt: string;
	/** Review feedback */
	feedback: ProposalFeedbackItem[];
	/** Reviewer ID */
	reviewedBy?: string;
	/** When reviewed */
	reviewedAt?: string;
	/** Review notes */
	reviewNotes?: string;
	/** Whether this proposal led to a lease claim */
	claimed: boolean;
	/** When claimed (if applicable) */
	claimedAt?: string;
	/** Lease expiration (if claimed) */
	leaseExpiresAt?: string;
	/** Version for optimistic concurrency */
	version: number;
}

/** Lease on a proposal */
export interface ProposalLease {
	/** Leased proposal ID */
	proposalId: string;
	/** Agent holding the lease */
	agentId: string;
	/** Proposal that led to this lease */
	sourceProposalId?: string;
	/** When lease started */
	leasedAt: string;
	/** When lease expires */
	expiresAt: string;
	/** Lease status */
	status: "active" | "expired" | "released" | "revoked";
	/** Last heartbeat timestamp */
	lastHeartbeat: string;
}

/** Proposal history entry for retrospective analysis */
export interface ProposalHistoryEntry {
	/** Entry ID */
	entryId: string;
	/** What happened */
	event:
		| "submitted"
		| "approved"
		| "rejected"
		| "withdrawn"
		| "claimed"
		| "expired";
	/** Which proposal */
	proposalId: string;
	/** Agent involved */
	agentId: string;
	/** Timestamp */
	timestamp: string;
	/** Additional context */
	metadata?: Record<string, unknown>;
}

/** Proposal query filter */
export interface ProposalFilter {
	proposalId?: string;
	agentId?: string;
	status?: ProposalStatus;
	since?: string;
	until?: string;
}

/** Lease heartbeat result */
export type LeaseHeartbeatResult =
	| { ok: true; lease: ProposalLease }
	| { ok: false; reason: "not-found" | "expired" | "wrong-agent" };

// ─── Constants ───────────────────────────────────────────────────────────

/** Default lease TTL in milliseconds (30 minutes) */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** Lease heartbeat interval (5 minutes) */
const _LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Complexity score mapping */
const COMPLEXITY_SCORES: Record<ComplexityLevel, number> = {
	trivial: 1,
	low: 3,
	medium: 5,
	high: 7,
	"very-high": 10,
};

// ─── Agent Proposal System ──────────────────────────────────────────────

/**
 * Manages agent proposals and lease-based claiming.
 */
export class AgentProposalSystem {
	private proposals: Map<string, AgentProposal> = new Map();
	private leases: Map<string, ProposalLease> = new Map();
	private history: ProposalHistoryEntry[] = [];
	private leaseTtlMs: number;

	constructor(options?: { leaseTtlMs?: number; proposalDir?: string }) {
		this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

		// Load persisted data if proposalDir provided
		if (options?.proposalDir) {
			this.loadFromDisk(options.proposalDir);
		}
	}

	// ─── AC#1: Agent Can Submit a Proposal ─────────────────────────

	/**
	 * Submit a proposal for a proposal.
	 */
	submitProposal(
		proposalId: string,
		agentId: string,
		options: {
			title: string;
			summary: string;
			approach: ImplementationApproach;
			complexity: ComplexityEstimate;
		},
	): AgentProposal {
		// Check for existing pending proposal or unclaimed approved proposal for this proposal
		const existing = this.getActiveProposalsForProposal(proposalId);
		if (
			existing.some(
				(p) =>
					p.status === "pending" || (p.status === "approved" && !p.claimed),
			)
		) {
			throw new Error(
				`Proposal ${proposalId} already has an active proposal: ${existing[0]?.proposalId}`,
			);
		}

		// Check if there's an active lease
		const lease = this.leases.get(proposalId);
		if (
			lease &&
			lease.status === "active" &&
			new Date(lease.expiresAt) > new Date()
		) {
			throw new Error(
				`Proposal ${proposalId} is already leased to ${lease.agentId}`,
			);
		}

		const now = new Date().toISOString();
		const proposal: AgentProposal = {
			proposalId: generateId("PROP"),
			targetProposalId: proposalId,
			agentId,
			title: options.title,
			summary: options.summary,
			approach: options.approach,
			complexity: options.complexity,
			status: "pending",
			submittedAt: now,
			updatedAt: now,
			feedback: [],
			claimed: false,
			version: 1,
		};

		this.proposals.set(proposal.proposalId, proposal);
		this.recordHistory("submitted", proposal);

		return proposal;
	}

	/**
	 * Get a proposal by ID.
	 */
	getProposal(proposalId: string): AgentProposal | undefined {
		return this.proposals.get(proposalId);
	}

	/**
	 * Get all proposals matching a filter.
	 */
	getProposals(filter?: ProposalFilter): AgentProposal[] {
		let results = Array.from(this.proposals.values());

		if (filter) {
			if (filter.proposalId) {
				results = results.filter((p) => p.proposalId === filter.proposalId);
			}
			if (filter.agentId) {
				results = results.filter((p) => p.agentId === filter.agentId);
			}
			if (filter.status) {
				results = results.filter((p) => p.status === filter.status);
			}
			if (filter.since) {
				const since = new Date(filter.since);
				results = results.filter((p) => new Date(p.submittedAt) >= since);
			}
			if (filter.until) {
				const until = new Date(filter.until);
				results = results.filter((p) => new Date(p.submittedAt) <= until);
			}
		}

		// Sort by submission date, newest first
		results.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
		return results;
	}

	/**
	 * Get active (pending or approved) proposals for a proposal.
	 */
	getActiveProposalsForProposal(proposalId: string): AgentProposal[] {
		return Array.from(this.proposals.values()).filter(
			(p) =>
				p.proposalId === proposalId &&
				(p.status === "pending" || p.status === "approved"),
		);
	}

	/**
	 * Get proposals by a specific agent.
	 */
	getProposalsByAgent(agentId: string): AgentProposal[] {
		return this.getProposals({ agentId });
	}

	// ─── AC#2: Approach + Complexity ────────────────────────────────

	/**
	 * Update the implementation approach on a pending proposal.
	 */
	updateApproach(
		proposalId: string,
		agentId: string,
		approach: ImplementationApproach,
	): AgentProposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
		if (proposal.agentId !== agentId)
			throw new Error("Only the proposing agent can update");
		if (proposal.status !== "pending")
			throw new Error(`Cannot update proposal in status: ${proposal.status}`);

		proposal.approach = approach;
		proposal.updatedAt = new Date().toISOString();
		proposal.version++;

		return proposal;
	}

	/**
	 * Update the complexity estimate on a pending proposal.
	 */
	updateComplexity(
		proposalId: string,
		agentId: string,
		complexity: ComplexityEstimate,
	): AgentProposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
		if (proposal.agentId !== agentId)
			throw new Error("Only the proposing agent can update");
		if (proposal.status !== "pending")
			throw new Error(`Cannot update proposal in status: ${proposal.status}`);

		proposal.complexity = complexity;
		proposal.updatedAt = new Date().toISOString();
		proposal.version++;

		return proposal;
	}

	/**
	 * Calculate a complexity summary for a proposal.
	 */
	getComplexitySummary(proposalId: string): {
		level: ComplexityLevel;
		score: number;
		taskCount: number;
		blockedTaskCount: number;
		estimatedHours?: number;
		confidence: number;
	} | null {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) return null;

		return {
			level: proposal.complexity.level,
			score: proposal.complexity.score,
			taskCount: proposal.complexity.tasks.length,
			blockedTaskCount: proposal.complexity.tasks.filter(
				(t) => t.dependsOn.length > 0,
			).length,
			estimatedHours: proposal.complexity.estimatedHours,
			confidence: proposal.complexity.confidence,
		};
	}

	// ─── AC#3: Proposal Review Workflow ─────────────────────────────

	/**
	 * Approve a proposal.
	 */
	approveProposal(
		proposalId: string,
		reviewerId: string,
		options?: { notes?: string; feedback?: ProposalFeedbackItem[] },
	): AgentProposal {
		return this.reviewProposal(proposalId, reviewerId, true, options);
	}

	/**
	 * Reject a proposal.
	 */
	rejectProposal(
		proposalId: string,
		reviewerId: string,
		options?: { notes?: string; feedback?: ProposalFeedbackItem[] },
	): AgentProposal {
		return this.reviewProposal(proposalId, reviewerId, false, options);
	}

	/**
	 * Withdraw a proposal (by the proposing agent).
	 */
	withdrawProposal(proposalId: string, agentId: string): AgentProposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
		if (proposal.agentId !== agentId)
			throw new Error("Only the proposing agent can withdraw");
		if (proposal.status !== "pending")
			throw new Error(`Cannot withdraw proposal in status: ${proposal.status}`);

		proposal.status = "withdrawn";
		proposal.updatedAt = new Date().toISOString();
		proposal.version++;

		this.recordHistory("withdrawn", proposal);
		return proposal;
	}

	/**
	 * Get proposals pending review.
	 */
	getPendingProposals(): AgentProposal[] {
		return this.getProposals({ status: "pending" });
	}

	/**
	 * Get review statistics.
	 */
	getReviewStats(): {
		pending: number;
		approved: number;
		rejected: number;
		withdrawn: number;
		expired: number;
		avgReviewTimeMs?: number;
		approvalRate: number;
	} {
		const all = Array.from(this.proposals.values());
		const reviewed = all.filter((p) => p.reviewedAt);

		let avgReviewTime: number | undefined;
		if (reviewed.length > 0) {
			const totalMs = reviewed.reduce((sum, p) => {
				const submitted = new Date(p.submittedAt).getTime();
				const reviewedAt = new Date(p.reviewedAt!).getTime();
				return sum + (reviewedAt - submitted);
			}, 0);
			avgReviewTime = totalMs / reviewed.length;
		}

		const decided = all.filter(
			(p) => p.status === "approved" || p.status === "rejected",
		);

		return {
			pending: all.filter((p) => p.status === "pending").length,
			approved: all.filter((p) => p.status === "approved").length,
			rejected: all.filter((p) => p.status === "rejected").length,
			withdrawn: all.filter((p) => p.status === "withdrawn").length,
			expired: all.filter((p) => p.status === "expired").length,
			avgReviewTimeMs: avgReviewTime,
			approvalRate:
				decided.length > 0
					? all.filter((p) => p.status === "approved").length / decided.length
					: 0,
		};
	}

	// ─── AC#4: Only Approved Proposals Can Claim (Lease) ───────────

	/**
	 * Claim a proposal via an approved proposal. Creates a lease.
	 */
	claimProposal(proposalId: string): ProposalLease {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
		if (proposal.status !== "approved") {
			throw new Error(
				`Proposal must be approved before claiming. Current status: ${proposal.status}`,
			);
		}
		if (proposal.claimed) {
			throw new Error(
				`Proposal ${proposalId} has already been used to claim proposal ${proposal.proposalId}`,
			);
		}

		// Check if proposal already has an active lease
		const existingLease = this.leases.get(proposal.proposalId);
		if (existingLease && existingLease.status === "active") {
			if (new Date(existingLease.expiresAt) > new Date()) {
				throw new Error(
					`Proposal ${proposal.proposalId} already leased to ${existingLease.agentId}`,
				);
			}
			// Lease expired, release it
			existingLease.status = "expired";
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.leaseTtlMs);

		const lease: ProposalLease = {
			proposalId: proposal.proposalId,
			agentId: proposal.agentId,
			leasedAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			status: "active",
			lastHeartbeat: now.toISOString(),
		};

		this.leases.set(proposal.proposalId, lease);

		// Mark proposal as claimed
		proposal.claimed = true;
		proposal.claimedAt = now.toISOString();
		proposal.leaseExpiresAt = expiresAt.toISOString();
		proposal.updatedAt = now.toISOString();
		proposal.version++;

		this.recordHistory("claimed", proposal);

		return lease;
	}

	/**
	 * Get the current lease for a proposal.
	 */
	getLease(proposalId: string): ProposalLease | undefined {
		const lease = this.leases.get(proposalId);
		if (!lease) return undefined;

		// Check if expired
		if (lease.status === "active" && new Date(lease.expiresAt) < new Date()) {
			lease.status = "expired";
		}

		return lease;
	}

	/**
	 * Check if a proposal is currently leased.
	 */
	isProposalLeased(proposalId: string): boolean {
		const lease = this.getLease(proposalId);
		return lease?.status === "active";
	}

	/**
	 * Send a heartbeat to renew a lease.
	 */
	heartbeatLease(proposalId: string, agentId: string): LeaseHeartbeatResult {
		const lease = this.leases.get(proposalId);

		if (!lease) return { ok: false, reason: "not-found" };
		if (lease.agentId !== agentId) return { ok: false, reason: "wrong-agent" };
		if (lease.status !== "active") return { ok: false, reason: "expired" };
		if (new Date(lease.expiresAt) < new Date()) {
			lease.status = "expired";
			return { ok: false, reason: "expired" };
		}

		// Renew the lease
		const now = new Date();
		lease.lastHeartbeat = now.toISOString();
		lease.expiresAt = new Date(now.getTime() + this.leaseTtlMs).toISOString();

		return { ok: true, lease };
	}

	/**
	 * Release a lease (agent voluntarily releases the proposal).
	 */
	releaseLease(proposalId: string, agentId: string): boolean {
		const lease = this.leases.get(proposalId);
		if (!lease) return false;
		if (lease.agentId !== agentId) return false;

		lease.status = "released";
		return true;
	}

	/**
	 * Revoke a lease (admin action for policy violation).
	 */
	revokeLease(proposalId: string, revokedBy: string, reason?: string): boolean {
		const lease = this.leases.get(proposalId);
		if (!lease || lease.status !== "active") return false;

		lease.status = "revoked";

		// Record the revocation in history
		this.history.push({
			entryId: generateId("HIST"),
			event: "expired",
			proposalId: lease.proposalId ?? "no-proposal",
			agentId: revokedBy,
			timestamp: new Date().toISOString(),
			metadata: { action: "revoked", reason, previousAgent: lease.agentId },
		});

		return true;
	}

	/**
	 * Get all active leases.
	 */
	getActiveLeases(): ProposalLease[] {
		const now = new Date();
		return Array.from(this.leases.values()).filter(
			(l) => l.status === "active" && new Date(l.expiresAt) > now,
		);
	}

	/**
	 * Get leases held by a specific agent.
	 */
	getAgentLeases(agentId: string): ProposalLease[] {
		return Array.from(this.leases.values()).filter(
			(l) => l.agentId === agentId,
		);
	}

	/**
	 * Clean up expired leases.
	 */
	cleanupExpiredLeases(): number {
		const now = new Date();
		let cleaned = 0;

		for (const lease of this.leases.values()) {
			if (lease.status === "active" && new Date(lease.expiresAt) < now) {
				lease.status = "expired";
				cleaned++;
			}
		}

		return cleaned;
	}

	// ─── AC#5: Proposal Feedback Visible to All Agents ─────────────

	/**
	 * Get all feedback for a proposal.
	 */
	getProposalFeedback(proposalId: string): ProposalFeedbackItem[] {
		const proposal = this.proposals.get(proposalId);
		return proposal ? proposal.feedback : [];
	}

	/**
	 * Get feedback for all proposals targeting a given proposal.
	 */
	getFeedbackForTarget(targetProposalId: string): Array<{
		proposalId: string;
		agentId: string;
		feedback: ProposalFeedbackItem[];
		status: ProposalStatus;
	}> {
		return Array.from(this.proposals.values())
			.filter(
				(p) => p.targetProposalId === targetProposalId && p.feedback.length > 0,
			)
			.map((p) => ({
				proposalId: p.proposalId,
				agentId: p.agentId,
				feedback: p.feedback,
				status: p.status,
			}));
	}

	/**
	 * Get learning signal summary - common feedback patterns.
	 */
	getLearningSignals(): {
		commonCategories: Map<string, number>;
		blockerCount: number;
		warningCount: number;
		infoCount: number;
		topIssues: string[];
	} {
		const categoryCounts = new Map<string, number>();
		let blockerCount = 0;
		let warningCount = 0;
		let infoCount = 0;
		const topIssues: string[] = [];

		for (const proposal of this.proposals.values()) {
			for (const fb of proposal.feedback) {
				categoryCounts.set(
					fb.category,
					(categoryCounts.get(fb.category) ?? 0) + 1,
				);
				if (fb.severity === "blocker") blockerCount++;
				else if (fb.severity === "warning") warningCount++;
				else infoCount++;

				if (fb.severity === "blocker" && fb.content) {
					topIssues.push(fb.content);
				}
			}
		}

		return {
			commonCategories: categoryCounts,
			blockerCount,
			warningCount,
			infoCount,
			topIssues: topIssues.slice(0, 10),
		};
	}

	// ─── AC#6: Proposal History for Retrospective ──────────────────

	/**
	 * Get proposal history for a proposal.
	 */
	getProposalHistory(proposalId: string): ProposalHistoryEntry[] {
		return this.history.filter((h) => h.proposalId === proposalId);
	}

	/**
	 * Get proposal history for an agent.
	 */
	getAgentHistory(agentId: string): ProposalHistoryEntry[] {
		return this.history.filter((h) => h.agentId === agentId);
	}

	/**
	 * Get full history with optional filtering.
	 */
	getHistory(filter?: {
		proposalId?: string;
		agentId?: string;
		event?: ProposalHistoryEntry["event"];
		since?: string;
	}): ProposalHistoryEntry[] {
		let results = [...this.history];

		if (filter) {
			if (filter.proposalId)
				results = results.filter((h) => h.proposalId === filter.proposalId);
			if (filter.agentId)
				results = results.filter((h) => h.agentId === filter.agentId);
			if (filter.event)
				results = results.filter((h) => h.event === filter.event);
			if (filter.since) {
				const since = new Date(filter.since);
				results = results.filter((h) => new Date(h.timestamp) >= since);
			}
		}

		results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return results;
	}

	/**
	 * Get retrospective summary for a time period.
	 */
	getRetrospective(
		since: string,
		until?: string,
	): {
		totalProposals: number;
		approvedCount: number;
		rejectedCount: number;
		avgComplexityScore: number;
		agentActivity: Map<
			string,
			{ submitted: number; approved: number; rejected: number }
		>;
		proposalQuality: number; // ratio of approved/(total-rejected-withdrawn)
	} {
		let entries = this.history.filter(
			(h) => new Date(h.timestamp) >= new Date(since),
		);
		if (until) {
			entries = entries.filter((h) => new Date(h.timestamp) <= new Date(until));
		}

		const submittedProposals = entries.filter((h) => h.event === "submitted");
		const approvedProposals = entries.filter((h) => h.event === "approved");
		const rejectedProposals = entries.filter((h) => h.event === "rejected");

		const agentActivity = new Map<
			string,
			{ submitted: number; approved: number; rejected: number }
		>();

		for (const entry of submittedProposals) {
			const existing = agentActivity.get(entry.agentId) ?? {
				submitted: 0,
				approved: 0,
				rejected: 0,
			};
			existing.submitted++;
			agentActivity.set(entry.agentId, existing);
		}

		for (const entry of approvedProposals) {
			const existing = agentActivity.get(entry.agentId) ?? {
				submitted: 0,
				approved: 0,
				rejected: 0,
			};
			existing.approved++;
			agentActivity.set(entry.agentId, existing);
		}

		for (const entry of rejectedProposals) {
			const existing = agentActivity.get(entry.agentId) ?? {
				submitted: 0,
				approved: 0,
				rejected: 0,
			};
			existing.rejected++;
			agentActivity.set(entry.agentId, existing);
		}

		// Calculate average complexity
		const complexityScores = Array.from(this.proposals.values())
			.filter((p) =>
				submittedProposals.some((e) => e.proposalId === p.proposalId),
			)
			.map((p) => p.complexity.score);

		const avgComplexity =
			complexityScores.length > 0
				? complexityScores.reduce((a, b) => a + b, 0) / complexityScores.length
				: 0;

		const totalDecided = approvedProposals.length + rejectedProposals.length;
		const quality =
			totalDecided > 0 ? approvedProposals.length / totalDecided : 0;

		return {
			totalProposals: submittedProposals.length,
			approvedCount: approvedProposals.length,
			rejectedCount: rejectedProposals.length,
			avgComplexityScore: avgComplexity,
			agentActivity,
			proposalQuality: quality,
		};
	}

	/**
	 * Persist data to disk.
	 */
	persistToDisk(proposalDir: string): void {
		if (!existsSync(proposalDir)) {
			mkdirSync(proposalDir, { recursive: true });
		}

		const data = {
			proposals: Array.from(this.proposals.values()),
			leases: Array.from(this.leases.values()),
			history: this.history,
		};

		writeFileSync(
			join(proposalDir, "agent-proposals.json"),
			JSON.stringify(data, null, 2),
			"utf-8",
		);
	}

	/**
	 * Load persisted data from disk.
	 */
	loadFromDisk(proposalDir: string): void {
		const filePath = join(proposalDir, "agent-proposals.json");
		if (!existsSync(filePath)) return;

		try {
			const content = readFileSync(filePath, "utf-8");
			const data = JSON.parse(content);

			if (data.proposals) {
				for (const p of data.proposals) {
					this.proposals.set(p.proposalId, p);
				}
			}
			if (data.leases) {
				for (const l of data.leases) {
					this.leases.set(l.proposalId, l);
				}
			}
			if (data.history) {
				this.history = data.history;
			}
		} catch {
			// Ignore load errors
		}
	}

	// ─── Internal Methods ───────────────────────────────────────────

	private reviewProposal(
		proposalId: string,
		reviewerId: string,
		approve: boolean,
		options?: { notes?: string; feedback?: ProposalFeedbackItem[] },
	): AgentProposal {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
		if (proposal.status !== "pending") {
			throw new Error(`Cannot review proposal in status: ${proposal.status}`);
		}

		proposal.status = approve ? "approved" : "rejected";
		proposal.reviewedBy = reviewerId;
		proposal.reviewedAt = new Date().toISOString();
		proposal.reviewNotes = options?.notes;
		proposal.updatedAt = proposal.reviewedAt;
		proposal.version++;

		if (options?.feedback) {
			proposal.feedback.push(...options.feedback);
		}

		this.recordHistory(approve ? "approved" : "rejected", proposal);

		return proposal;
	}

	private recordHistory(
		event: ProposalHistoryEntry["event"],
		proposal: AgentProposal,
	): void {
		this.history.push({
			entryId: generateId("HIST"),
			event,
			proposalId: proposal.proposalId,
			agentId: proposal.agentId,
			timestamp: new Date().toISOString(),
			metadata: {
				title: proposal.title,
				complexity: proposal.complexity.level,
				complexityScore: proposal.complexity.score,
				status: proposal.status,
			},
		});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a unique ID with prefix.
 */
function generateId(prefix: string): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create a complexity estimate helper.
 */
export function createComplexityEstimate(
	level: ComplexityLevel,
	options?: {
		tasks?: ComplexTask[];
		estimatedHours?: number;
		confidence?: number;
	},
): ComplexityEstimate {
	return {
		level,
		score: COMPLEXITY_SCORES[level],
		tasks: options?.tasks ?? [],
		estimatedHours: options?.estimatedHours,
		confidence: options?.confidence ?? 0.5,
	};
}

/**
 * Create an implementation approach helper.
 */
export function createApproach(
	type: ApproachType,
	description: string,
	options?: Partial<ImplementationApproach>,
): ImplementationApproach {
	return {
		type,
		description,
		filesAffected: options?.filesAffected ?? [],
		dependencies: options?.dependencies ?? [],
		estimatedTimeline: options?.estimatedTimeline ?? "TBD",
		testingStrategy:
			options?.testingStrategy ?? "Unit tests + integration tests",
		risks: options?.risks ?? [],
		rollbackPlan: options?.rollbackPlan,
	};
}
