import type { Proposal } from "../../types/index.ts";
import { isCompleteStatus } from "../proposal/directives.ts";

export interface ProposalStatistics {
	statusCounts: Map<string, number>;
	priorityCounts: Map<string, number>;
	totalProposals: number;
	completedProposals: number;
	completionPercentage: number;
	draftCount: number;
	recentActivity: {
		created: Proposal[];
		updated: Proposal[];
	};
	projectHealth: {
		averageProposalAge: number;
		staleProposals: Proposal[];
		blockedProposals: Proposal[];
	};
}

/**
 * Calculate comprehensive proposal statistics for the overview
 */
export function getProposalStatistics(
	proposals: Proposal[],
	drafts: Proposal[],
	statuses: string[],
): ProposalStatistics {
	const statusCounts = new Map<string, number>();
	const priorityCounts = new Map<string, number>();

	// Initialize status counts
	for (const status of statuses) {
		statusCounts.set(status, 0);
	}

	// Initialize priority counts
	priorityCounts.set("high", 0);
	priorityCounts.set("medium", 0);
	priorityCounts.set("low", 0);
	priorityCounts.set("none", 0);

	let completedProposals = 0;
	const now = new Date();
	const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

	const recentlyCreated: Proposal[] = [];
	const recentlyUpdated: Proposal[] = [];
	const staleProposals: Proposal[] = [];
	const blockedProposals: Proposal[] = [];
	let totalAge = 0;
	let proposalCount = 0;

	// Process each proposal
	for (const proposal of proposals) {
		// Skip proposals with empty or undefined status
		if (!proposal.status || proposal.status === "") {
			continue;
		}

		// Count by status
		const currentCount = statusCounts.get(proposal.status) || 0;
		statusCounts.set(proposal.status, currentCount + 1);

		const isReached = isCompleteStatus(proposal.status);

		// Count completed proposals
		if (isReached) {
			completedProposals++;
		}

		// Count by priority
		const priority = proposal.priority || "none";
		const priorityCount = priorityCounts.get(priority) || 0;
		priorityCounts.set(priority, priorityCount + 1);

		// Track recent activity
		if (proposal.createdDate) {
			const createdDate = new Date(proposal.createdDate);
			if (createdDate >= oneWeekAgo) {
				recentlyCreated.push(proposal);
			}

			// Calculate proposal age
			// For completed proposals, use the time from creation to completion
			// For active proposals, use the time from creation to now
			let ageInDays: number;
			if (isReached && proposal.updatedDate) {
				const updatedDate = new Date(proposal.updatedDate);
				ageInDays = Math.floor(
					(updatedDate.getTime() - createdDate.getTime()) /
						(24 * 60 * 60 * 1000),
				);
			} else {
				ageInDays = Math.floor(
					(now.getTime() - createdDate.getTime()) / (24 * 60 * 60 * 1000),
				);
			}
			totalAge += ageInDays;
			proposalCount++;
		}

		if (proposal.updatedDate) {
			const updatedDate = new Date(proposal.updatedDate);
			if (updatedDate >= oneWeekAgo) {
				recentlyUpdated.push(proposal);
			}
		}

		// Identify stale proposals (not updated in 30 days and not done)
		if (!isReached) {
			const lastDate = proposal.updatedDate || proposal.createdDate;
			if (lastDate) {
				const date = new Date(lastDate);
				if (date < oneMonthAgo) {
					staleProposals.push(proposal);
				}
			}
		}

		// Identify blocked proposals (has dependencies that are not done)
		if (
			proposal.dependencies &&
			proposal.dependencies.length > 0 &&
			!isReached
		) {
			// Check if any dependency is not done
			const hasBlockingDependency = proposal.dependencies.some((depId) => {
				const dep = proposals.find((t) => t.id === depId);
				return dep && !isCompleteStatus(dep.status);
			});

			if (hasBlockingDependency) {
				blockedProposals.push(proposal);
			}
		}
	}

	// Sort recent activity by date
	recentlyCreated.sort((a, b) => {
		const dateA = new Date(a.createdDate || 0);
		const dateB = new Date(b.createdDate || 0);
		return dateB.getTime() - dateA.getTime();
	});

	recentlyUpdated.sort((a, b) => {
		const dateA = new Date(a.updatedDate || 0);
		const dateB = new Date(b.updatedDate || 0);
		return dateB.getTime() - dateA.getTime();
	});

	// Calculate average proposal age
	const averageProposalAge =
		proposalCount > 0 ? Math.round(totalAge / proposalCount) : 0;

	// Calculate completion percentage (only count proposals with valid status)
	const totalProposals = Array.from(statusCounts.values()).reduce(
		(sum, count) => sum + count,
		0,
	);
	const completionPercentage =
		totalProposals > 0
			? Math.round((completedProposals / totalProposals) * 100)
			: 0;

	return {
		statusCounts,
		priorityCounts,
		totalProposals,
		completedProposals,
		completionPercentage,
		draftCount: drafts.length,
		recentActivity: {
			created: recentlyCreated.slice(0, 5), // Top 5 most recent
			updated: recentlyUpdated.slice(0, 5), // Top 5 most recent
		},
		projectHealth: {
			averageProposalAge,
			staleProposals: staleProposals.slice(0, 5), // Top 5 stale proposals
			blockedProposals: blockedProposals.slice(0, 5), // Top 5 blocked proposals
		},
	};
}
