/**
 * STATE-42: Obstacle-to-Proposal Pipeline
 *
 * Automatically converts obstacle nodes (blocked tasks) into proper roadmap
 * proposals with full ACs and implementation plans. When an agent hits a blocker,
 * it can escalate to a proposal for others to help solve.
 *
 * AC#1: Obstacle can be promoted to proposal via CLI/MCP
 * AC#2: Promoted proposal includes context from original obstacle
 * AC#3: Blocking relationship preserved in dependencies
 * AC#4: Agent who created obstacle notified when promoted proposal is resolved
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Original obstacle data */
export interface Obstacle {
	/** Unique obstacle ID */
	id: string;
	/** Obstacle title */
	title: string;
	/** Detailed description */
	description: string;
	/** Proposal ID(s) this obstacle is blocking */
	blockingProposalIds: string[];
	/** Agent who reported the obstacle */
	reportedBy: string;
	/** When obstacle was created */
	createdAt: string;
	/** Severity level */
	severity: "low" | "medium" | "high" | "critical";
	/** Related proposal IDs (non-blocking context) */
	relatedProposalIds?: string[];
	/** Suggested resolution approach */
	suggestedApproach?: string;
}

/** Result of promoting obstacle to proposal */
export interface PromotionResult {
	/** Whether promotion succeeded */
	success: boolean;
	/** New proposal ID created */
	newProposalId: string;
	/** The promoted proposal data */
	proposal: PromotedProposal;
	/** Any warnings */
	warnings: string[];
}

/** Promoted proposal structure */
export interface PromotedProposal {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	assignee: string[];
	labels: string[];
	dependencies: string[];
	implementationPlan: string;
	metadata: {
		originalObstacleId: string;
		promotedAt: string;
		promotedBy: string;
		blockingProposalIds: string[];
		notificationTarget?: string;
	};
}

/** Obstacle storage */
interface ObstacleStore {
	obstacles: Obstacle[];
	promotions: Array<{
		obstacleId: string;
		newProposalId: string;
		promotedAt: string;
		promotedBy: string;
	}>;
}

/**
 * Obstacle-to-Proposal Pipeline
 */
export class ObstaclePipeline {
	private storePath: string;
	private store: ObstacleStore;
	private projectRoot: string;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.storePath = join(projectRoot, "roadmap", ".cache", "obstacles.json");
		this.store = this.loadStore();
	}

	/**
	 * Load obstacle store from disk.
	 */
	private loadStore(): ObstacleStore {
		if (existsSync(this.storePath)) {
			try {
				return JSON.parse(readFileSync(this.storePath, "utf-8"));
			} catch {
				return { obstacles: [], promotions: [] };
			}
		}
		return { obstacles: [], promotions: [] };
	}

	/**
	 * Save obstacle store to disk.
	 */
	private saveStore(): void {
		const dir = join(this.projectRoot, "roadmap", ".cache");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
	}

	/**
	 * Generate next obstacle ID.
	 */
	private generateObstacleId(): string {
		const maxNum = this.store.obstacles.reduce((max, o) => {
			const match = o.id.match(/OBS-(\d+)/);
			if (match) {
				return Math.max(max, parseInt(match[1], 10));
			}
			return max;
		}, 0);
		return `OBS-${String(maxNum + 1).padStart(3, "0")}`;
	}

	/**
	 * AC#1: Create an obstacle.
	 */
	createObstacle(data: {
		title: string;
		description: string;
		blockingProposalIds: string[];
		reportedBy: string;
		severity?: Obstacle["severity"];
		relatedProposalIds?: string[];
		suggestedApproach?: string;
	}): Obstacle {
		const obstacle: Obstacle = {
			id: this.generateObstacleId(),
			title: data.title,
			description: data.description,
			blockingProposalIds: data.blockingProposalIds,
			reportedBy: data.reportedBy,
			createdAt: new Date().toISOString(),
			severity: data.severity || "medium",
			relatedProposalIds: data.relatedProposalIds,
			suggestedApproach: data.suggestedApproach,
		};

		this.store.obstacles.push(obstacle);
		this.saveStore();
		return obstacle;
	}

	/**
	 * AC#1: Promote obstacle to proposal.
	 */
	promoteToProposal(
		obstacleId: string,
		options?: {
			promotedBy?: string;
			customTitle?: string;
			extraDeps?: string[];
		},
	): PromotionResult {
		const obstacle = this.store.obstacles.find((o) => o.id === obstacleId);
		if (!obstacle) {
			return {
				success: false,
				newProposalId: "",
				proposal: {} as PromotedProposal,
				warnings: [`Obstacle ${obstacleId} not found`],
			};
		}

		const promotedBy = options?.promotedBy || "system";
		const newProposalId = `STATE-${Date.now().toString(36).toUpperCase()}`;

		// AC#2: Build proposal with full context from obstacle
		const proposal: PromotedProposal = {
			id: newProposalId,
			title: options?.customTitle || `[RESOLVE] ${obstacle.title}`,
			description: this.buildProposalDescription(obstacle),
			status: "New",
			priority: this.severityToPriority(obstacle.severity),
			assignee: [obstacle.reportedBy],
			labels: ["obstacle", "blocking", obstacle.severity],
			// AC#3: Preserve blocking relationship in dependencies
			dependencies: [
				...obstacle.blockingProposalIds,
				...(options?.extraDeps || []),
			],
			implementationPlan: this.buildImplementationPlan(obstacle),
			metadata: {
				originalObstacleId: obstacle.id,
				promotedAt: new Date().toISOString(),
				promotedBy,
				blockingProposalIds: obstacle.blockingProposalIds,
				notificationTarget: obstacle.reportedBy,
			},
		};

		// Record promotion
		this.store.promotions.push({
			obstacleId,
			newProposalId,
			promotedAt: new Date().toISOString(),
			promotedBy,
		});
		this.saveStore();

		return {
			success: true,
			newProposalId,
			proposal,
			warnings: [],
		};
	}

	/**
	 * AC#2: Build proposal description with obstacle context.
	 */
	private buildProposalDescription(obstacle: Obstacle): string {
		const lines = [
			`## Obstacle Resolution`,
			``,
			`**Original Obstacle:** ${obstacle.id}`,
			`**Reported by:** ${obstacle.reportedBy}`,
			`**Severity:** ${obstacle.severity}`,
			`**Blocking:** ${obstacle.blockingProposalIds.join(", ")}`,
			``,
			`### Description`,
			`${obstacle.description}`,
			``,
		];

		if (obstacle.suggestedApproach) {
			lines.push("### Suggested Approach");
			lines.push(`${obstacle.suggestedApproach}`);
			lines.push("");
		}

		if (obstacle.relatedProposalIds?.length) {
			lines.push("### Related Proposals");
			lines.push(`${obstacle.relatedProposalIds.join(", ")}`);
			lines.push("");
		}

		lines.push("### Acceptance Criteria");
		lines.push("- [ ] Root cause identified");
		lines.push("- [ ] Solution implemented");
		lines.push("- [ ] Blocking proposals verified as unblocked");
		lines.push("- [ ] Original reporter notified of resolution");

		return lines.join("\n");
	}

	/**
	 * Build implementation plan from obstacle data.
	 */
	private buildImplementationPlan(obstacle: Obstacle): string {
		const lines = [
			`1. Analyze root cause of: ${obstacle.title}`,
			`2. Coordinate with blocking proposals: ${obstacle.blockingProposalIds.join(", ")}`,
		];

		if (obstacle.suggestedApproach) {
			lines.push(
				`3. Implement suggested approach: ${obstacle.suggestedApproach}`,
			);
			lines.push(`4. Verify resolution unblocks dependent proposals`);
		} else {
			lines.push(`3. Determine and implement solution`);
			lines.push(`4. Verify resolution unblocks dependent proposals`);
		}

		return lines.join("\n");
	}

	/**
	 * Map severity to priority.
	 */
	private severityToPriority(severity: Obstacle["severity"]): string {
		const map: Record<string, string> = {
			critical: "high",
			high: "high",
			medium: "medium",
			low: "low",
		};
		return map[severity] || "medium";
	}

	/**
	 * AC#4: Check if a resolved proposal should notify obstacle reporter.
	 */
	getNotificationTarget(newProposalId: string): string | null {
		const promotion = this.store.promotions.find(
			(p) => p.newProposalId === newProposalId,
		);
		if (!promotion) return null;

		const obstacle = this.store.obstacles.find(
			(o) => o.id === promotion.obstacleId,
		);
		return obstacle?.reportedBy || null;
	}

	/**
	 * AC#4: Mark obstacle as resolved.
	 */
	markResolved(obstacleId: string, resolvedBy: string): boolean {
		const obstacle = this.store.obstacles.find((o) => o.id === obstacleId);
		if (!obstacle) return false;

		// Add resolvedAt field
		(obstacle as any).resolvedAt = new Date().toISOString();
		(obstacle as any).resolvedBy = resolvedBy;
		this.saveStore();
		return true;
	}

	/**
	 * Get all obstacles.
	 */
	getObstacles(options?: { unresolvedOnly?: boolean }): Obstacle[] {
		let obstacles = [...this.store.obstacles];

		if (options?.unresolvedOnly) {
			obstacles = obstacles.filter((o) => !(o as any).resolvedAt);
		}

		return obstacles.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	}

	/**
	 * Get obstacle by ID.
	 */
	getObstacle(id: string): Obstacle | null {
		return this.store.obstacles.find((o) => o.id === id) || null;
	}

	/**
	 * Get promotion history.
	 */
	getPromotions(): ObstacleStore["promotions"] {
		return [...this.store.promotions].reverse();
	}

	/**
	 * Get obstacles blocking a specific proposal.
	 */
	getBlockingObstacles(proposalId: string): Obstacle[] {
		return this.store.obstacles.filter(
			(o) =>
				o.blockingProposalIds.includes(proposalId) && !(o as any).resolvedAt,
		);
	}

	/**
	 * Delete an obstacle (if not promoted).
	 */
	deleteObstacle(obstacleId: string): boolean {
		const promoted = this.store.promotions.some(
			(p) => p.obstacleId === obstacleId,
		);
		if (promoted) return false;

		const idx = this.store.obstacles.findIndex((o) => o.id === obstacleId);
		if (idx === -1) return false;

		this.store.obstacles.splice(idx, 1);
		this.saveStore();
		return true;
	}

	/**
	 * Get pipeline statistics.
	 */
	getStats(): {
		totalObstacles: number;
		unresolved: number;
		promoted: number;
		blockingCount: number;
	} {
		const unresolved = this.store.obstacles.filter(
			(o) => !(o as any).resolvedAt,
		);
		const blocking = unresolved.filter((o) => o.blockingProposalIds.length > 0);

		return {
			totalObstacles: this.store.obstacles.length,
			unresolved: unresolved.length,
			promoted: this.store.promotions.length,
			blockingCount: blocking.length,
		};
	}
}

/**
 * Create an obstacle pipeline for a project.
 */
export function createObstaclePipeline(projectRoot: string): ObstaclePipeline {
	return new ObstaclePipeline(projectRoot);
}
