/**
 * Proposal loading with optimized index-first, hydrate-later pattern
 * Dramatically reduces git operations for multi-branch proposal loading
 *
 * This is the single module for all cross-branch proposal loading:
 * - Local filesystem proposals
 * - Other local branch proposals
 * - Remote branch proposals
 */

import { DEFAULT_DIRECTORIES } from "../../constants/index.ts";
import type { GitOperations } from "../../git/operations.ts";
import { parseProposal } from "../../markdown/parser.ts";
import type { Proposal, RoadmapConfig } from "../../types/index.ts";
import { normalizeId } from "../../utils/prefix-config.ts";
import {
	extractProposalIdFromFilePath,
	normalizeProposalId,
	normalizeProposalIdentity,
} from "../../utils/proposal-path.ts";
import type { ProposalDirectoryType } from "../dag/cross-branch-proposals.ts";

/** Default prefix for proposals */
const DEFAULT_STATE_PREFIX = "proposal";

export interface BranchProposalProposalEntry {
	id: string;
	type: ProposalDirectoryType;
	lastModified: Date;
	branch: string;
	path: string;
}

const STATE_DIRECTORIES: Array<{ path: string; type: ProposalDirectoryType }> =
	[
		{ path: "proposals", type: "proposal" },
		{ path: "drafts", type: "draft" },
		{ path: "archive/proposals", type: "archived" },
		{ path: "completed", type: "completed" },
	];

function getProposalTypeFromPath(
	path: string,
	roadmapDir: string,
): ProposalDirectoryType | null {
	const normalized = path.startsWith(`${roadmapDir}/`)
		? path.slice(roadmapDir.length + 1)
		: path;

	for (const { path: dir, type } of STATE_DIRECTORIES) {
		if (normalized.startsWith(`${dir}/`)) {
			return type;
		}
	}

	return null;
}

/**
 * Get the appropriate loading message based on remote operations configuration
 */
export function getProposalLoadingMessage(
	config: RoadmapConfig | null,
): string {
	return config?.remoteOperations === false
		? "Loading proposals from local branches..."
		: "Loading proposals from local and remote branches...";
}

interface RemoteIndexEntry {
	id: string;
	branch: string;
	path: string; // "roadmap/proposals/proposal-123 - title.md"
	lastModified: Date;
}

function normalizeRemoteBranch(branch: string): string | null {
	let br = branch.trim();
	if (!br) return null;
	br = br.replace(/^refs\/remotes\//, "");
	if (br === "origin" || br === "HEAD" || br === "origin/HEAD") return null;
	if (br.startsWith("origin/")) br = br.slice("origin/".length);
	// Filter weird cases like "origin" again after stripping prefix
	if (!br || br === "HEAD" || br === "origin") return null;
	return br;
}

/**
 * Normalize a local branch name, filtering out invalid entries
 */
function normalizeLocalBranch(
	branch: string,
	currentBranch: string,
): string | null {
	const br = branch.trim();
	if (!br) return null;
	// Skip HEAD, origin refs, and current branch
	if (br === "HEAD" || br.includes("HEAD")) return null;
	if (br.startsWith("origin/") || br.startsWith("refs/remotes/")) return null;
	if (br === "origin") return null;
	// Skip current branch - we already have its proposals from filesystem
	if (br === currentBranch) return null;
	return br;
}

/**
 * Build a cheap index of remote proposals without fetching content
 * This is VERY fast as it only lists files and gets modification times in batch
 */
export async function buildRemoteProposalIndex(
	git: GitOperations,
	branches: string[],
	roadmapDir = "roadmap",
	sinceDays?: number,
	proposalCollector?: BranchProposalProposalEntry[],
	_prefix = DEFAULT_STATE_PREFIX,
	includeCompleted = false,
): Promise<Map<string, RemoteIndexEntry[]>> {
	const out = new Map<string, RemoteIndexEntry[]>();

	const normalized = branches
		.map(normalizeRemoteBranch)
		.filter((b): b is string => Boolean(b));

	// Do branches in parallel but not unbounded
	const CONCURRENCY = 4;
	const queue = [...normalized];

	const workers = Array.from(
		{ length: Math.min(CONCURRENCY, queue.length) },
		async () => {
			while (queue.length) {
				const br = queue.pop();
				if (!br) break;

				const ref = `origin/${br}`;

				try {
					const listPath = proposalCollector
						? roadmapDir
						: `${roadmapDir}/proposals`;

					// Get roadmap files for this branch
					const files = await git.listFilesInTree(ref, listPath);
					if (files.length === 0) continue;

					// Get last modified times for all files in one pass
					const lm = await git.getBranchLastModifiedMap(
						ref,
						listPath,
						sinceDays,
					);

					for (const f of files) {
						const id = extractProposalIdFromFilePath(f);
						if (!id) continue;
						const lastModified = lm.get(f) ?? new Date(0);
						const entry: RemoteIndexEntry = {
							id,
							branch: br,
							path: f,
							lastModified,
						};

						// Collect full proposal info when requested
						const type = getProposalTypeFromPath(f, roadmapDir);
						if (!proposalCollector && type !== "proposal") {
							continue;
						}
						if (type && proposalCollector) {
							proposalCollector.push({
								id,
								type,
								branch: br,
								path: f,
								lastModified,
							});
						}

						// Only index active proposals for hydration selection (optionally include completed)
						if (
							type === "proposal" ||
							(includeCompleted && type === "completed")
						) {
							const arr = out.get(id);
							if (arr) {
								arr.push(entry);
							} else {
								out.set(id, [entry]);
							}
						}
					}
				} catch (error) {
					// Branch might not have roadmap directory, skip it
					console.debug(`Skipping branch ${br}: ${error}`);
				}
			}
		},
	);

	await Promise.all(workers);
	return out;
}

/**
 * Hydrate proposals by fetching their content
 * Only call this for the "winner" proposals that we actually need
 */
async function hydrateProposals(
	git: GitOperations,
	winners: Array<{ id: string; ref: string; path: string }>,
): Promise<Proposal[]> {
	const CONCURRENCY = 8;
	const result: Proposal[] = [];
	let i = 0;

	async function worker() {
		while (i < winners.length) {
			const idx = i++;
			if (idx >= winners.length) break;

			const w = winners[idx];
			if (!w) break;

			try {
				const content = await git.showFile(w.ref, w.path);
				const proposal = normalizeProposalIdentity(parseProposal(content));
				if (proposal) {
					// Mark as remote source and branch
					proposal.source = "remote";
					// Extract branch name from ref (e.g., "origin/main" -> "main")
					proposal.branch = w.ref.replace("origin/", "");
					result.push(proposal);
				}
			} catch (error) {
				console.error(
					`Failed to hydrate proposal ${w.id} from ${w.ref}:${w.path}`,
					error,
				);
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, winners.length) }, worker),
	);
	return result;
}

/**
 * Build a cheap index of proposals from local branches (excluding current branch)
 * Similar to buildRemoteProposalIndex but for local refs
 */
export async function buildLocalBranchProposalIndex(
	git: GitOperations,
	branches: string[],
	currentBranch: string,
	roadmapDir = "roadmap",
	sinceDays?: number,
	proposalCollector?: BranchProposalProposalEntry[],
	_prefix = DEFAULT_STATE_PREFIX,
	includeCompleted = false,
): Promise<Map<string, RemoteIndexEntry[]>> {
	const out = new Map<string, RemoteIndexEntry[]>();

	const normalized = branches
		.map((b) => normalizeLocalBranch(b, currentBranch))
		.filter((b): b is string => Boolean(b));

	if (normalized.length === 0) {
		return out;
	}

	// Do branches in parallel but not unbounded
	const CONCURRENCY = 4;
	const queue = [...normalized];

	const workers = Array.from(
		{ length: Math.min(CONCURRENCY, queue.length) },
		async () => {
			while (queue.length) {
				const br = queue.pop();
				if (!br) break;

				try {
					const listPath = proposalCollector
						? roadmapDir
						: `${roadmapDir}/proposals`;

					// Get roadmap files in this branch
					const files = await git.listFilesInTree(br, listPath);
					if (files.length === 0) continue;

					// Get last modified times for all files in one pass
					const lm = await git.getBranchLastModifiedMap(
						br,
						listPath,
						sinceDays,
					);

					for (const f of files) {
						const id = extractProposalIdFromFilePath(f);
						if (!id) continue;
						const lastModified = lm.get(f) ?? new Date(0);
						const entry: RemoteIndexEntry = {
							id,
							branch: br,
							path: f,
							lastModified,
						};

						// Collect full proposal info when requested
						const type = getProposalTypeFromPath(f, roadmapDir);
						if (!proposalCollector && type !== "proposal") {
							continue;
						}
						if (type && proposalCollector) {
							proposalCollector.push({
								id,
								type,
								branch: br,
								path: f,
								lastModified,
							});
						}

						// Only index active proposals for hydration selection (optionally include completed)
						if (
							type === "proposal" ||
							(includeCompleted && type === "completed")
						) {
							const arr = out.get(id);
							if (arr) {
								arr.push(entry);
							} else {
								out.set(id, [entry]);
							}
						}
					}
				} catch (error) {
					// Branch might not have roadmap directory, skip it
					if (process.env.DEBUG) {
						console.debug(`Skipping local branch ${br}: ${error}`);
					}
				}
			}
		},
	);

	await Promise.all(workers);
	return out;
}

/**
 * Choose which remote proposals need to be hydrated based on strategy
 * Returns only the proposals that are newer or more progressed than local versions
 */
function chooseWinners(
	localById: Map<string, Proposal>,
	remoteIndex: Map<string, RemoteIndexEntry[]>,
	strategy: "most_recent" | "most_progressed" = "most_progressed",
): Array<{ id: string; ref: string; path: string }> {
	const winners: Array<{ id: string; ref: string; path: string }> = [];

	for (const [id, entries] of remoteIndex) {
		const local = localById.get(id);

		if (!local) {
			// No local version - take the newest remote
			const best = entries.reduce((a, b) =>
				a.lastModified >= b.lastModified ? a : b,
			);
			winners.push({ id, ref: `origin/${best.branch}`, path: best.path });
			continue;
		}

		// If strategy is "most_recent", only hydrate if any remote is newer
		if (strategy === "most_recent") {
			const localTs = local.updatedDate
				? new Date(local.updatedDate).getTime()
				: 0;
			const newestRemote = entries.reduce((a, b) =>
				a.lastModified >= b.lastModified ? a : b,
			);

			if (newestRemote.lastModified.getTime() > localTs) {
				winners.push({
					id,
					ref: `origin/${newestRemote.branch}`,
					path: newestRemote.path,
				});
			}
			continue;
		}

		// For "most_progressed", we might need to check if remote is newer
		// to potentially have a more progressed status
		const localTs = local.updatedDate
			? new Date(local.updatedDate).getTime()
			: 0;
		const maybeNewer = entries.some((e) => e.lastModified.getTime() > localTs);

		if (maybeNewer) {
			// Only hydrate the newest remote to check if it's more progressed
			const newestRemote = entries.reduce((a, b) =>
				a.lastModified >= b.lastModified ? a : b,
			);
			winners.push({
				id,
				ref: `origin/${newestRemote.branch}`,
				path: newestRemote.path,
			});
		}
	}

	return winners;
}

/**
 * Find and load a specific proposal from remote branches
 * Searches through recent remote branches for the proposal and returns the newest version
 */
export async function findProposalInRemoteBranches(
	git: GitOperations,
	proposalId: string,
	roadmapDir = "roadmap",
	sinceDays = 30,
	prefix = DEFAULT_STATE_PREFIX,
): Promise<Proposal | null> {
	try {
		// Check if we have any remote
		if (!(await git.hasAnyRemote())) return null;

		// Get recent remote branches
		const branches = await git.listRecentRemoteBranches(sinceDays);
		if (branches.length === 0) return null;

		// Build proposal index for remote branches
		const remoteIndex = await buildRemoteProposalIndex(
			git,
			branches,
			roadmapDir,
			sinceDays,
			undefined,
			prefix,
		);

		const normalizedId = normalizeId(proposalId, prefix);

		// Check if the proposal exists in the index
		const entries = remoteIndex.get(normalizedId);
		if (!entries || entries.length === 0) return null;

		// Get the newest version
		const best = entries.reduce((a, b) =>
			a.lastModified >= b.lastModified ? a : b,
		);

		// Hydrate the proposal
		const ref = `origin/${best.branch}`;
		const content = await git.showFile(ref, best.path);
		const proposal = normalizeProposalIdentity(parseProposal(content));
		if (proposal) {
			proposal.source = "remote";
			proposal.branch = best.branch;
		}
		return proposal;
	} catch (error) {
		if (process.env.DEBUG) {
			console.error(
				`Failed to find proposal ${proposalId} in remote branches:`,
				error,
			);
		}
		return null;
	}
}

/**
 * Find and load a specific proposal from local branches (excluding current branch)
 * Searches through recent local branches for the proposal and returns the newest version
 */
export async function findProposalInLocalBranches(
	git: GitOperations,
	proposalId: string,
	roadmapDir = "roadmap",
	sinceDays = 30,
	prefix = DEFAULT_STATE_PREFIX,
): Promise<Proposal | null> {
	try {
		const currentBranch = await git.getCurrentBranch();
		if (!currentBranch) return null;

		// Get recent local branches
		const allBranches = await git.listRecentBranches(sinceDays);
		const localBranches = allBranches.filter(
			(b) =>
				!b.startsWith("origin/") &&
				!b.startsWith("refs/remotes/") &&
				b !== "origin",
		);

		if (localBranches.length <= 1) return null; // Only current branch

		// Build proposal index for local branches
		const localIndex = await buildLocalBranchProposalIndex(
			git,
			localBranches,
			currentBranch,
			roadmapDir,
			sinceDays,
			undefined,
			prefix,
		);

		const normalizedId = normalizeId(proposalId, prefix);

		// Check if the proposal exists in the index
		const entries = localIndex.get(normalizedId);
		if (!entries || entries.length === 0) return null;

		// Get the newest version
		const best = entries.reduce((a, b) =>
			a.lastModified >= b.lastModified ? a : b,
		);

		// Hydrate the proposal
		const content = await git.showFile(best.branch, best.path);
		const proposal = normalizeProposalIdentity(parseProposal(content));
		if (proposal) {
			proposal.source = "local-branch";
			proposal.branch = best.branch;
		}
		return proposal;
	} catch (error) {
		if (process.env.DEBUG) {
			console.error(
				`Failed to find proposal ${proposalId} in local branches:`,
				error,
			);
		}
		return null;
	}
}

/**
 * Load all remote proposals using optimized index-first, hydrate-later pattern
 * Dramatically reduces git operations by only fetching content for proposals that need it
 */
export async function loadRemoteProposals(
	gitOps: GitOperations,
	userConfig: RoadmapConfig | null = null,
	onProgress?: (message: string) => void,
	localProposals?: Proposal[],
	proposalCollector?: BranchProposalProposalEntry[],
	includeCompleted = false,
): Promise<Proposal[]> {
	try {
		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] loadRemoteProposals: remoteOperations=",
				userConfig?.remoteOperations,
				", checkActiveBranches=",
				userConfig?.checkActiveBranches,
			);
			console.error(
				"[DEBUG] Checking if remote operations should be skipped...",
			);
		}
		// Skip remote operations if disabled
		if (
			userConfig?.remoteOperations === false ||
			userConfig?.checkActiveBranches === false
		) {
			if (process.env.DEBUG) {
				console.error(
					"[DEBUG] Skipping remote proposals - remoteOperations=",
					userConfig?.remoteOperations,
					", checkActiveBranches=",
					userConfig?.checkActiveBranches,
				);
			}
			onProgress?.("Remote operations disabled - skipping remote proposals");
			return [];
		}

		// Fetch remote branches
		onProgress?.("Fetching remote branches...");
		await gitOps.fetch();

		// Use recent branches only for better performance
		const days = userConfig?.activeBranchDays ?? 30;
		const branches = await gitOps.listRecentRemoteBranches(days);

		if (branches.length === 0) {
			onProgress?.("No recent remote branches found");
			return [];
		}

		onProgress?.(
			`Indexing ${branches.length} recent remote branches (last ${days} days)...`,
		);

		// Build a cheap index without fetching content
		const roadmapDir = DEFAULT_DIRECTORIES.ROADMAP;
		const proposalPrefix =
			userConfig?.prefixes?.proposal ?? DEFAULT_STATE_PREFIX;
		const remoteIndex = await buildRemoteProposalIndex(
			gitOps,
			branches,
			roadmapDir,
			days,
			proposalCollector,
			proposalPrefix,
			includeCompleted,
		);

		if (remoteIndex.size === 0) {
			onProgress?.("No remote proposals found");
			return [];
		}

		onProgress?.(
			`Found ${remoteIndex.size} unique proposals across remote branches`,
		);

		// If we have local proposals, use them to determine which remote proposals to hydrate
		let winners: Array<{ id: string; ref: string; path: string }>;

		if (localProposals && localProposals.length > 0) {
			const localById = new Map(
				localProposals.map((t) => [normalizeProposalId(t.id), t]),
			);
			const strategy =
				userConfig?.proposalResolutionStrategy || "most_progressed";

			// Only hydrate remote proposals that are newer or missing locally
			winners = chooseWinners(localById, remoteIndex, strategy);
			onProgress?.(`Hydrating ${winners.length} remote candidates...`);
		} else {
			// No local proposals, need to hydrate all remote proposals (take newest of each)
			winners = [];
			for (const [id, entries] of remoteIndex) {
				const best = entries.reduce((a, b) =>
					a.lastModified >= b.lastModified ? a : b,
				);
				winners.push({ id, ref: `origin/${best.branch}`, path: best.path });
			}
			onProgress?.(`Hydrating ${winners.length} remote proposals...`);
		}

		// Only fetch content for the proposals we actually need
		const hydratedProposals = await hydrateProposals(gitOps, winners);

		onProgress?.(`Loaded ${hydratedProposals.length} remote proposals`);
		return hydratedProposals;
	} catch (error) {
		// If fetch fails, we can still work with local proposals
		console.error("Failed to fetch remote proposals:", error);
		return [];
	}
}

/**
 * Resolve conflicts between local and remote proposals based on strategy
 */
function getProposalDate(proposal: Proposal): Date {
	if (proposal.updatedDate) {
		return new Date(proposal.updatedDate);
	}
	return proposal.lastModified ?? new Date(0);
}

export function resolveProposalConflict(
	existing: Proposal,
	incoming: Proposal,
	statuses: string[],
	strategy: "most_recent" | "most_progressed" = "most_progressed",
): Proposal {
	if (strategy === "most_recent") {
		const existingDate = getProposalDate(existing);
		const incomingDate = getProposalDate(incoming);
		return existingDate >= incomingDate ? existing : incoming;
	}

	// Default to most_progressed strategy
	// Map status to rank (default to 0 for unknown statuses)
	const currentIdx = statuses.indexOf(existing.status);
	const newIdx = statuses.indexOf(incoming.status);
	const currentRank = currentIdx >= 0 ? currentIdx : 0;
	const newRank = newIdx >= 0 ? newIdx : 0;

	// If incoming proposal has a more progressed status, use it
	if (newRank > currentRank) {
		return incoming;
	}

	// If statuses are equal, use the most recent
	if (newRank === currentRank) {
		if (existing.origin === "local" && incoming.origin !== "local") {
			return existing;
		}
		if (incoming.origin === "local" && existing.origin !== "local") {
			return incoming;
		}
		const existingDate = getProposalDate(existing);
		const incomingDate = getProposalDate(incoming);
		return existingDate >= incomingDate ? existing : incoming;
	}

	return existing;
}

/**
 * Load proposals from other local branches (not current branch, not remote)
 * Uses the same optimized index-first, hydrate-later pattern as remote loading
 */
export async function loadLocalBranchProposals(
	gitOps: GitOperations,
	userConfig: RoadmapConfig | null = null,
	onProgress?: (message: string) => void,
	localProposals?: Proposal[],
	proposalCollector?: BranchProposalProposalEntry[],
	includeCompleted = false,
): Promise<Proposal[]> {
	try {
		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] loadLocalBranchProposals: checkActiveBranches=",
				userConfig?.checkActiveBranches,
			);
		}
		// Skip local branch loading if checkActiveBranches is false
		if (userConfig?.checkActiveBranches === false) {
			if (process.env.DEBUG) {
				console.error(
					"[DEBUG] Skipping local branch proposals - checkActiveBranches=false",
				);
			}
			return [];
		}
		const currentBranch = await gitOps.getCurrentBranch();
		if (!currentBranch) {
			// Not on a branch (detached HEAD), skip local branch loading
			return [];
		}

		// Get recent local branches (excludes remote refs)
		const days = userConfig?.activeBranchDays ?? 30;
		const allBranches = await gitOps.listRecentBranches(days);

		// Filter to only local branches (not origin/*)
		const localBranches = allBranches.filter(
			(b) =>
				!b.startsWith("origin/") &&
				!b.startsWith("refs/remotes/") &&
				b !== "origin",
		);

		if (localBranches.length <= 1) {
			// Only current branch or no branches
			return [];
		}

		onProgress?.(
			`Indexing ${localBranches.length - 1} other local branches...`,
		);

		// Build index of proposals from other local branches
		const roadmapDir = DEFAULT_DIRECTORIES.ROADMAP;
		const proposalPrefix =
			userConfig?.prefixes?.proposal ?? DEFAULT_STATE_PREFIX;
		const localBranchIndex = await buildLocalBranchProposalIndex(
			gitOps,
			localBranches,
			currentBranch,
			roadmapDir,
			days,
			proposalCollector,
			proposalPrefix,
			includeCompleted,
		);

		if (localBranchIndex.size === 0) {
			return [];
		}

		onProgress?.(
			`Found ${localBranchIndex.size} unique proposals in other local branches`,
		);

		// Determine which proposals to hydrate
		let winners: Array<{ id: string; ref: string; path: string }>;

		if (localProposals && localProposals.length > 0) {
			const localById = new Map(
				localProposals.map((t) => [normalizeProposalId(t.id), t]),
			);
			const strategy =
				userConfig?.proposalResolutionStrategy || "most_progressed";

			// Only hydrate proposals that are missing locally or potentially newer
			winners = [];
			for (const [id, entries] of localBranchIndex) {
				const local = localById.get(id);

				if (!local) {
					// Proposal doesn't exist locally - take the newest from other branches
					const best = entries.reduce((a, b) =>
						a.lastModified >= b.lastModified ? a : b,
					);
					winners.push({ id, ref: best.branch, path: best.path });
					continue;
				}

				// For existing proposals, check if any other branch version is newer
				if (strategy === "most_recent") {
					const localTs = local.updatedDate
						? new Date(local.updatedDate).getTime()
						: 0;
					const newestOther = entries.reduce((a, b) =>
						a.lastModified >= b.lastModified ? a : b,
					);

					if (newestOther.lastModified.getTime() > localTs) {
						winners.push({
							id,
							ref: newestOther.branch,
							path: newestOther.path,
						});
					}
				} else {
					// For most_progressed, we need to hydrate to check status
					const localTs = local.updatedDate
						? new Date(local.updatedDate).getTime()
						: 0;
					const maybeNewer = entries.some(
						(e) => e.lastModified.getTime() > localTs,
					);

					if (maybeNewer) {
						const newestOther = entries.reduce((a, b) =>
							a.lastModified >= b.lastModified ? a : b,
						);
						winners.push({
							id,
							ref: newestOther.branch,
							path: newestOther.path,
						});
					}
				}
			}
		} else {
			// No local proposals, hydrate all from other branches (take newest of each)
			winners = [];
			for (const [id, entries] of localBranchIndex) {
				const best = entries.reduce((a, b) =>
					a.lastModified >= b.lastModified ? a : b,
				);
				winners.push({ id, ref: best.branch, path: best.path });
			}
		}

		if (winners.length === 0) {
			return [];
		}

		onProgress?.(
			`Hydrating ${winners.length} proposals from other local branches...`,
		);

		// Hydrate the proposals - note: ref is the branch name directly (not origin/)
		const hydratedProposals = await hydrateProposals(gitOps, winners);

		// Mark these as coming from local branches
		for (const proposal of hydratedProposals) {
			proposal.source = "local-branch";
		}

		onProgress?.(
			`Loaded ${hydratedProposals.length} proposals from other local branches`,
		);
		return hydratedProposals;
	} catch (error) {
		if (process.env.DEBUG) {
			console.error("Failed to load local branch proposals:", error);
		}
		return [];
	}
}
