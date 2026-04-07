/**
 * STATE-44: Per-Agent Rate Limiting & Fair Share
 *
 * Prevents one fast agent from starving others by limiting proposal claims
 * per time window. Ensures fair distribution of work across all agents.
 *
 * AC#1: Configurable claim limit per agent per hour
 * AC#2: Queue system when limit reached
 * AC#3: Priority boost for critical proposals bypasses limit
 * AC#4: Rate limit status visible in agent profile
 * AC#5: Global fair-share policy configurable
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RateLimitConfig {
	/** Maximum claims per agent per hour (default: 10) */
	maxClaimsPerHour: number;
	/** Burst allowance - extra claims in short window (default: 3) */
	burstAllowance: number;
	/** Burst window in minutes (default: 5) */
	burstWindowMinutes: number;
	/** Priority bypass - critical proposals skip rate limit (default: true) */
	priorityBypass: boolean;
	/** Minimum priority for bypass (default: "high") */
	minBypassPriority: "high" | "medium" | "low";
	/** Cool-down period after limit reached, in minutes (default: 15) */
	coolDownMinutes: number;
}

export interface AgentRateStatus {
	agentId: string;
	/** Claims in current hour window */
	claimsInWindow: number;
	/** Maximum allowed in window */
	maxAllowed: number;
	/** Burst claims used in current burst window */
	burstUsed: number;
	/** Burst allowance remaining */
	burstRemaining: number;
	/** Whether agent is currently rate-limited */
	isLimited: boolean;
	/** When the rate limit resets (ISO string) */
	resetsAt: string;
	/** Queue position if waiting (0 = not queued) */
	queuePosition: number;
}

export interface QueuedRequest {
	agentId: string;
	proposalPriority: string;
	enqueuedAt: string;
	expiresAt: string;
}

export interface FairSharePolicy {
	/** Enable fair share distribution */
	enabled: boolean;
	/** Minimum claims per agent per hour regardless of load (default: 2) */
	minClaimsPerHour: number;
	/** Rebalance interval in minutes (default: 30) */
	rebalanceIntervalMinutes: number;
	/** Recent activity window for fair share calculation (hours) */
	activityWindowHours: number;
}

interface ClaimRecord {
	agentId: string;
	timestamp: string;
	proposalId: string;
	proposalPriority: string;
	bypassed: boolean;
}

interface AgentProposal {
	claims: ClaimRecord[];
	burstClaims: ClaimRecord[];
	queue: QueuedRequest[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
	maxClaimsPerHour: 10,
	burstAllowance: 3,
	burstWindowMinutes: 5,
	priorityBypass: true,
	minBypassPriority: "high",
	coolDownMinutes: 15,
};

const DEFAULT_FAIR_SHARE: FairSharePolicy = {
	enabled: true,
	minClaimsPerHour: 2,
	rebalanceIntervalMinutes: 30,
	activityWindowHours: 4,
};

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Per-Agent Rate Limiter with fair share support.
 */
export class RateLimiter {
	private config: RateLimitConfig;
	private fairShare: FairSharePolicy;
	private agents: Map<string, AgentProposal> = new Map();
	private proposalPath: string;
	private projectPath: string;

	constructor(
		projectPath: string,
		config?: Partial<RateLimitConfig>,
		fairShare?: Partial<FairSharePolicy>,
	) {
		this.projectPath = projectPath;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.fairShare = { ...DEFAULT_FAIR_SHARE, ...fairShare };
		this.proposalPath = join(
			projectPath,
			"roadmap",
			".cache",
			"rate-limiter.json",
		);
		this.loadProposal();
	}

	/**
	 * Load persisted proposal from disk.
	 */
	private loadProposal(): void {
		if (existsSync(this.proposalPath)) {
			try {
				const data = JSON.parse(readFileSync(this.proposalPath, "utf-8"));
				this.config = { ...DEFAULT_CONFIG, ...data.config };
				this.fairShare = { ...DEFAULT_FAIR_SHARE, ...data.fairShare };
				// Convert arrays back to Map
				this.agents = new Map(Object.entries(data.agents ?? {}));
			} catch {
				// Corrupted file, start fresh
			}
		}
	}

	/**
	 * Persist proposal to disk.
	 */
	private saveProposal(): void {
		const dir = join(this.projectPath, "roadmap", ".cache");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const data = {
			config: this.config,
			fairShare: this.fairShare,
			agents: Object.fromEntries(this.agents),
		};
		writeFileSync(this.proposalPath, JSON.stringify(data, null, 2));
	}

	/**
	 * Get or create agent proposal.
	 */
	private getAgentProposal(agentId: string): AgentProposal {
		if (!this.agents.has(agentId)) {
			this.agents.set(agentId, {
				claims: [],
				burstClaims: [],
				queue: [],
			});
		}
		return this.agents.get(agentId)!;
	}

	/**
	 * Clean expired records from agent proposal.
	 */
	private cleanExpired(agentProposal: AgentProposal): void {
		const now = Date.now();
		const hourAgo = new Date(now - HOUR_MS).toISOString();
		const burstAgo = new Date(
			now - this.config.burstWindowMinutes * MINUTE_MS,
		).toISOString();

		agentProposal.claims = agentProposal.claims.filter(
			(c) => c.timestamp > hourAgo,
		);
		agentProposal.burstClaims = agentProposal.burstClaims.filter(
			(c) => c.timestamp > burstAgo,
		);
		agentProposal.queue = agentProposal.queue.filter(
			(q) => q.expiresAt > new Date().toISOString(),
		);
	}

	/**
	 * Check if a claim should bypass rate limit based on priority.
	 */
	private shouldBypass(proposalPriority: string): boolean {
		if (!this.config.priorityBypass) return false;

		const priorityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
		const bypassRank = priorityRank[this.config.minBypassPriority] ?? 3;
		const claimRank = priorityRank[proposalPriority.toLowerCase()] ?? 1;

		return claimRank >= bypassRank;
	}

	/**
	 * AC#1, AC#2, AC#3: Check if agent can claim a proposal.
	 * Returns status and optional queue position.
	 */
	canClaim(
		agentId: string,
		_proposalId: string,
		proposalPriority: string = "medium",
	): {
		allowed: boolean;
		bypassed: boolean;
		queuePosition?: number;
		retryAfter?: string;
		reason?: string;
	} {
		const agentProposal = this.getAgentProposal(agentId);
		this.cleanExpired(agentProposal);

		// AC#3: Priority bypass
		const bypassed = this.shouldBypass(proposalPriority);
		if (bypassed) {
			return { allowed: true, bypassed: true };
		}

		// AC#1: Check hourly limit
		if (agentProposal.claims.length >= this.config.maxClaimsPerHour) {
			// AC#2: Queue system - add to queue
			const queueEntry: QueuedRequest = {
				agentId,
				proposalPriority,
				enqueuedAt: new Date().toISOString(),
				expiresAt: new Date(
					Date.now() + this.config.coolDownMinutes * MINUTE_MS,
				).toISOString(),
			};
			agentProposal.queue.push(queueEntry);
			this.saveProposal();

			const retryAfter = new Date(
				Date.now() + this.config.coolDownMinutes * MINUTE_MS,
			).toISOString();

			return {
				allowed: false,
				bypassed: false,
				queuePosition: agentProposal.queue.length,
				retryAfter,
				reason: `Rate limit: ${agentProposal.claims.length}/${this.config.maxClaimsPerHour} claims used. Retry after ${this.config.coolDownMinutes} minutes.`,
			};
		}

		// Check burst limit
		if (agentProposal.burstClaims.length >= this.config.burstAllowance) {
			const oldestBurst = agentProposal.burstClaims[0];
			if (oldestBurst) {
				const burstResetTime = new Date(
					new Date(oldestBurst.timestamp).getTime() +
						this.config.burstWindowMinutes * MINUTE_MS,
				);
				if (Date.now() < burstResetTime.getTime()) {
					return {
						allowed: false,
						bypassed: false,
						reason: `Burst limit: ${this.config.burstAllowance}/${this.config.burstAllowance} burst claims in ${this.config.burstWindowMinutes} minutes.`,
						retryAfter: burstResetTime.toISOString(),
					};
				}
			}
		}

		return { allowed: true, bypassed: false };
	}

	/**
	 * Record a claim for rate limiting purposes.
	 */
	recordClaim(
		agentId: string,
		proposalId: string,
		proposalPriority: string = "medium",
	): void {
		const agentProposal = this.getAgentProposal(agentId);
		const bypassed = this.shouldBypass(proposalPriority);

		const record: ClaimRecord = {
			agentId,
			timestamp: new Date().toISOString(),
			proposalId,
			proposalPriority,
			bypassed,
		};

		agentProposal.claims.push(record);

		// Only count towards burst if not bypassed
		if (!bypassed) {
			agentProposal.burstClaims.push(record);
		}

		this.saveProposal();
	}

	/**
	 * AC#4: Get rate limit status for an agent (visible in profile).
	 */
	getAgentStatus(agentId: string): AgentRateStatus {
		const agentProposal = this.getAgentProposal(agentId);
		this.cleanExpired(agentProposal);

		const claimsInWindow = agentProposal.claims.filter(
			(c) => !c.bypassed,
		).length;

		const burstUsed = agentProposal.burstClaims.length;
		const resetsAt = agentProposal.claims[0]
			? new Date(
					new Date(agentProposal.claims[0].timestamp).getTime() + HOUR_MS,
				).toISOString()
			: new Date().toISOString();

		return {
			agentId,
			claimsInWindow,
			maxAllowed: this.config.maxClaimsPerHour,
			burstUsed,
			burstRemaining: Math.max(0, this.config.burstAllowance - burstUsed),
			isLimited: claimsInWindow >= this.config.maxClaimsPerHour,
			resetsAt,
			queuePosition:
				agentProposal.queue.length > 0 ? agentProposal.queue.length : 0,
		};
	}

	/**
	 * AC#5: Update global fair-share policy.
	 */
	updateFairShare(policy: Partial<FairSharePolicy>): FairSharePolicy {
		this.fairShare = { ...this.fairShare, ...policy };
		this.saveProposal();
		return this.fairShare;
	}

	/**
	 * Get current fair-share policy.
	 */
	getFairSharePolicy(): FairSharePolicy {
		return { ...this.fairShare };
	}

	/**
	 * Update rate limit configuration.
	 */
	updateConfig(config: Partial<RateLimitConfig>): RateLimitConfig {
		this.config = { ...this.config, ...config };
		this.saveProposal();
		return this.config;
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): RateLimitConfig {
		return { ...this.config };
	}

	/**
	 * Get all agent statuses (for dashboard/monitoring).
	 */
	getAllAgentStatuses(): AgentRateStatus[] {
		const statuses: AgentRateStatus[] = [];
		for (const [agentId] of this.agents) {
			statuses.push(this.getAgentStatus(agentId));
		}
		return statuses.sort((a, b) => b.claimsInWindow - a.claimsInWindow);
	}

	/**
	 * Get queue for an agent.
	 */
	getAgentQueue(agentId: string): QueuedRequest[] {
		const agentProposal = this.getAgentProposal(agentId);
		this.cleanExpired(agentProposal);
		return [...agentProposal.queue];
	}

	/**
	 * Clear rate limit for an agent (admin override).
	 */
	clearAgentLimit(agentId: string): boolean {
		if (this.agents.has(agentId)) {
			const proposal = this.agents.get(agentId)!;
			proposal.claims = [];
			proposal.burstClaims = [];
			proposal.queue = [];
			this.saveProposal();
			return true;
		}
		return false;
	}

	/**
	 * Reset all rate limits (admin action).
	 */
	resetAllLimits(): void {
		this.agents.clear();
		this.saveProposal();
	}

	/**
	 * Get statistics for monitoring.
	 */
	getStats(): {
		totalAgents: number;
		limitedAgents: number;
		totalClaimsInWindow: number;
		queueLength: number;
		config: RateLimitConfig;
		fairShare: FairSharePolicy;
	} {
		let limitedAgents = 0;
		let totalClaims = 0;
		let queueLength = 0;

		for (const [, proposal] of this.agents) {
			this.cleanExpired(proposal);
			if (proposal.claims.length >= this.config.maxClaimsPerHour) {
				limitedAgents++;
			}
			totalClaims += proposal.claims.length;
			queueLength += proposal.queue.length;
		}

		return {
			totalAgents: this.agents.size,
			limitedAgents,
			totalClaimsInWindow: totalClaims,
			queueLength,
			config: this.config,
			fairShare: this.fairShare,
		};
	}
}
