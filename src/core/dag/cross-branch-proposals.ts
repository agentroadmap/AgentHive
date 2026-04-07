/**
 * Cross-branch proposal proposal resolution
 * Determines the latest proposal of proposals across all git branches
 */

import { DEFAULT_DIRECTORIES } from "../../constants/index.ts";
import type { FileSystem } from "../../file-system/operations.ts";
import type { GitOperations as GitOps } from "../../git/operations.ts";
import type { Proposal } from "../../types/index.ts";
import { buildPathIdRegex, normalizeId } from "../../utils/prefix-config.ts";

/** Default prefix for proposals */
const DEFAULT_STATE_PREFIX = "proposal";

export type ProposalDirectoryType =
	| "proposal"
	| "draft"
	| "archived"
	| "completed";

export interface ProposalDirectoryInfo {
	proposalId: string;
	type: ProposalDirectoryType;
	lastModified: Date;
	branch: string;
	path: string;
}

/**
 * Get the latest directory location of specific proposal IDs across all branches
 * Only checks the provided proposal IDs for optimal performance
 */
export async function getLatestProposalProposalsForIds(
	gitOps: GitOps,
	_filesystem: FileSystem,
	proposalIds: string[],
	onProgress?: (message: string) => void,
	options?: { recentBranchesOnly?: boolean; daysAgo?: number; prefix?: string },
): Promise<Map<string, ProposalDirectoryInfo>> {
	const prefix = options?.prefix ?? DEFAULT_STATE_PREFIX;
	const idRegex = buildPathIdRegex(prefix);
	const proposalDirectories = new Map<string, ProposalDirectoryInfo>();

	if (proposalIds.length === 0) {
		return proposalDirectories;
	}

	try {
		// Get branches - use recent branches by default for performance
		const useRecentOnly = options?.recentBranchesOnly ?? true;
		const daysAgo = options?.daysAgo ?? 30; // Default to 30 days if not specified

		let branches = useRecentOnly
			? await gitOps.listRecentBranches(daysAgo)
			: await gitOps.listAllBranches();

		if (branches.length === 0) {
			return proposalDirectories;
		}

		// Use standard roadmap directory
		const roadmapDir = DEFAULT_DIRECTORIES.ROADMAP;

		// Filter branches that actually have roadmap changes
		const branchesWithRoadmap: string[] = [];

		// Quick check which branches actually have the roadmap directory
		for (const branch of branches) {
			try {
				// Just check if the roadmap directory exists
				const files = await gitOps.listFilesInTree(branch, roadmapDir);
				if (files.length > 0) {
					branchesWithRoadmap.push(branch);
				}
			} catch {
				// Branch doesn't have roadmap directory
			}
		}

		// Use filtered branches
		branches = branchesWithRoadmap;

		// Count local vs remote branches for info
		const localBranches = branches.filter((b) => !b.includes("origin/"));
		const remoteBranches = branches.filter((b) => b.includes("origin/"));

		const branchMsg = useRecentOnly
			? `${branches.length} branches with roadmap (from ${daysAgo} days, ${localBranches.length} local, ${remoteBranches.length} remote)`
			: `${branches.length} branches with roadmap (${localBranches.length} local, ${remoteBranches.length} remote)`;
		onProgress?.(
			`Checking ${proposalIds.length} proposals across ${branchMsg}...`,
		);

		// Create all file path combinations we need to check
		const directoryChecks: Array<{
			path: string;
			type: ProposalDirectoryType;
		}> = [
			{ path: `${roadmapDir}/proposals`, type: "proposal" },
			{ path: `${roadmapDir}/drafts`, type: "draft" },
			{ path: `${roadmapDir}/archive/proposals`, type: "archived" },
			{ path: `${roadmapDir}/completed`, type: "completed" },
		];

		// For better performance, prioritize checking current branch and main branch first
		const priorityBranches = ["main", "master"];
		const currentBranch = await gitOps.getCurrentBranch();
		if (currentBranch && !priorityBranches.includes(currentBranch)) {
			priorityBranches.unshift(currentBranch);
		}

		// Check priority branches first
		for (const branch of priorityBranches) {
			if (!branches.includes(branch)) continue;

			// Remove from main list to avoid duplicate checking
			branches = branches.filter((b) => b !== branch);

			// Quick check for all proposals in this branch
			for (const { path, type } of directoryChecks) {
				try {
					const files = await gitOps.listFilesInTree(branch, path);
					if (files.length === 0) continue;

					// Get all modification times in one pass
					const modTimes = await gitOps.getBranchLastModifiedMap(branch, path);

					// Build file->id map for O(1) lookup
					const fileToId = new Map<string, string>();
					for (const f of files) {
						const filename = f.substring(f.lastIndexOf("/") + 1);
						const match = filename.match(idRegex);
						if (match?.[1]) {
							// Normalize the ID to canonical form for lookup
							const normalizedFileId = normalizeId(match[1], prefix);
							fileToId.set(normalizedFileId, f);
						}
					}

					// Check each proposal ID (normalize for lookup)
					for (const proposalId of proposalIds) {
						const normalizedProposalId = normalizeId(proposalId, prefix);
						const proposalFile = fileToId.get(normalizedProposalId);

						if (proposalFile) {
							const lastModified = modTimes.get(proposalFile);
							if (lastModified) {
								const existing = proposalDirectories.get(proposalId);
								if (!existing || lastModified > existing.lastModified) {
									proposalDirectories.set(proposalId, {
										proposalId,
										type,
										lastModified,
										branch,
										path: proposalFile,
									});
								}
							}
						}
					}
				} catch {
					// Skip directories that don't exist
				}
			}
		}

		// If we found all proposals in priority branches, we can skip other branches
		if (proposalDirectories.size === proposalIds.length) {
			onProgress?.(
				`Found all ${proposalIds.length} proposals in priority branches`,
			);
			return proposalDirectories;
		}

		// For remaining proposals, check other branches
		const remainingProposalIds = proposalIds.filter(
			(id) => !proposalDirectories.has(id),
		);
		if (remainingProposalIds.length === 0 || branches.length === 0) {
			onProgress?.(`Checked ${proposalIds.length} proposals`);
			return proposalDirectories;
		}

		onProgress?.(
			`Checking ${remainingProposalIds.length} remaining proposals across ${branches.length} branches...`,
		);

		// Check remaining branches in parallel batches
		const BRANCH_BATCH_SIZE = 5; // Process 5 branches at a time for better performance
		for (let i = 0; i < branches.length; i += BRANCH_BATCH_SIZE) {
			const branchBatch = branches.slice(i, i + BRANCH_BATCH_SIZE);

			await Promise.all(
				branchBatch.map(async (branch) => {
					for (const { path, type } of directoryChecks) {
						try {
							const files = await gitOps.listFilesInTree(branch, path);

							if (files.length === 0) continue;

							// Get all modification times in one pass
							const modTimes = await gitOps.getBranchLastModifiedMap(
								branch,
								path,
							);

							// Build file->id map for O(1) lookup
							const fileToId = new Map<string, string>();
							for (const f of files) {
								const filename = f.substring(f.lastIndexOf("/") + 1);
								const match = filename.match(idRegex);
								if (match?.[1]) {
									// Normalize the ID to canonical form for lookup
									const normalizedFileId = normalizeId(match[1], prefix);
									fileToId.set(normalizedFileId, f);
								}
							}

							for (const proposalId of remainingProposalIds) {
								// Skip if we already found this proposal
								const normalizedProposalId = normalizeId(proposalId, prefix);
								if (proposalDirectories.has(normalizedProposalId)) continue;

								const proposalFile = fileToId.get(normalizedProposalId);

								if (proposalFile) {
									const lastModified = modTimes.get(proposalFile);
									if (lastModified) {
										const existing = proposalDirectories.get(proposalId);
										if (!existing || lastModified > existing.lastModified) {
											proposalDirectories.set(proposalId, {
												proposalId,
												type,
												lastModified,
												branch,
												path: proposalFile,
											});
										}
									}
								}
							}
						} catch {
							// Skip directories that don't exist
						}
					}
				}),
			);

			// Early exit if we found all proposals
			if (proposalDirectories.size === proposalIds.length) {
				break;
			}
		}

		onProgress?.(`Checked ${proposalIds.length} proposals`);
	} catch (error) {
		console.error("Failed to get proposal directory locations for IDs:", error);
	}

	return proposalDirectories;
}

/**
 * Filter proposals based on their latest directory location across all branches
 * Only returns proposals whose latest directory type is "proposal" (not draft, archived, or completed)
 */
export function filterProposalsByLatestProposal(
	proposals: Proposal[],
	latestDirectories: Map<string, ProposalDirectoryInfo>,
): Proposal[] {
	return proposals.filter((proposal) => {
		const latestDirectory = latestDirectories.get(proposal.id);

		// If we don't have directory info, assume it's an active proposal
		if (!latestDirectory) {
			return true;
		}

		// Only show proposals whose latest directory type is "proposal"
		// Completed, archived, and draft proposals should not appear on the main board
		return latestDirectory.type === "proposal";
	});
}
