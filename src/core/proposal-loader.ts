/**
 * Proposal Loader — Branch Proposal Discovery
 *
 * Loads proposals from git branches (local + remote) for cross-branch
 * proposal tracking. Used by roadmap.ts to detect which proposals are
 * active across the repository.
 */

import type { GitOperations } from "../git/operations.ts";
import { parseProposal } from "../markdown/parser.ts";
import type { Proposal } from "../types/index.ts";

/** A proposal entry discovered on a branch */
export interface BranchProposalProposalEntry {
	id: string;
	type: "proposal" | "completed" | "draft" | "archived";
	branch: string;
	path: string;
	lastModified: Date;
}

/** Config shape (partial — only fields we need) */
interface LoaderConfig {
	activeBranchDays?: number;
	prefixes?: { proposal?: string };
	remoteOperations?: boolean;
}

/**
 * Get the git blob content for a file on a specific branch.
 */
async function getFileFromBranch(
	git: GitOperations,
	branch: string,
	filePath: string,
): Promise<string | null> {
	try {
		const { stdout } = await (git as any).execGit(
			["show", `${branch}:${filePath}`],
			{ readOnly: true },
		);
		return stdout?.trim() || null;
	} catch {
		return null;
	}
}

/**
 * List proposal files on a branch under a given directory.
 */
async function listFilesOnBranch(
	git: GitOperations,
	branch: string,
	dir: string,
): Promise<string[]> {
	try {
		const { stdout } = await (git as any).execGit(
			["ls-tree", "--name-only", "-r", branch, "--", dir],
			{ readOnly: true },
		);
		return stdout
			.split("\n")
			.filter((f: string) => f.endsWith(".md") && !f.includes("/README"))
			.map((f: string) => f.trim());
	} catch {
		return [];
	}
}

/**
 * Parse a proposal file from a branch and return an entry.
 */
async function loadProposalFromBranch(
	git: GitOperations,
	branch: string,
	filePath: string,
	_proposalPrefix: string,
): Promise<BranchProposalProposalEntry | null> {
	const content = await getFileFromBranch(git, branch, filePath);
	if (!content) return null;

	try {
		const proposal = parseProposal(content);
		if (!proposal.id) return null;

		// Determine type from status
		const status = proposal.status?.toLowerCase() ?? "";
		let type: BranchProposalProposalEntry["type"] = "proposal";
		if (
			status === "reached" ||
			status === "complete" ||
			status === "completed"
		) {
			type = "completed";
		} else if (status === "draft" || status === "potential") {
			type = "draft";
		} else if (status === "archived") {
			type = "archived";
		}

		// Get last modified date from the proposal or git
		const lastModified = proposal.updatedDate
			? new Date(proposal.updatedDate)
			: proposal.createdDate
				? new Date(proposal.createdDate)
				: new Date(0);

		return {
			id: proposal.id,
			type,
			branch,
			path: filePath,
			lastModified,
		};
	} catch {
		return null;
	}
}

/**
 * Find a specific proposal on local branches (excluding current branch).
 *
 * Scans branches from the last N days for a proposal matching the given ID.
 */
export async function findProposalInLocalBranches(
	git: GitOperations,
	proposalId: string,
	roadmapDir: string,
	sinceDays: number,
	proposalPrefix: string,
): Promise<BranchProposalProposalEntry | null> {
	const branches = await git.listRecentBranches(sinceDays);

	for (const branch of branches) {
		const files = await listFilesOnBranch(git, branch, roadmapDir);
		for (const filePath of files) {
			const entry = await loadProposalFromBranch(
				git,
				branch,
				filePath,
				proposalPrefix,
			);
			if (entry && entry.id === proposalId) {
				return entry;
			}
		}
	}

	return null;
}

/**
 * Find a specific proposal on remote branches.
 */
export async function findProposalInRemoteBranches(
	git: GitOperations,
	proposalId: string,
	roadmapDir: string,
	sinceDays: number,
	proposalPrefix: string,
): Promise<BranchProposalProposalEntry | null> {
	const branches = await git.listRecentRemoteBranches(sinceDays);

	for (const branch of branches) {
		const files = await listFilesOnBranch(git, branch, roadmapDir);
		for (const filePath of files) {
			const entry = await loadProposalFromBranch(
				git,
				branch,
				filePath,
				proposalPrefix,
			);
			if (entry && entry.id === proposalId) {
				return entry;
			}
		}
	}

	return null;
}

/**
 * Load all proposals from local branches into the entries array.
 */
export async function loadLocalBranchProposals(
	git: GitOperations,
	config: LoaderConfig | null | undefined,
	_progressCallback: ((msg: string) => void) | undefined,
	_localProposals: Proposal[],
	entries: BranchProposalProposalEntry[],
): Promise<void> {
	const sinceDays = config?.activeBranchDays ?? 30;
	const proposalPrefix = config?.prefixes?.proposal ?? "proposal";
	const roadmapDir = "roadmap";

	const branches = await git.listRecentBranches(sinceDays);

	for (const branch of branches) {
		const files = await listFilesOnBranch(git, branch, roadmapDir);
		for (const filePath of files) {
			const entry = await loadProposalFromBranch(
				git,
				branch,
				filePath,
				proposalPrefix,
			);
			if (entry) {
				entries.push(entry);
			}
		}
	}
}

/**
 * Load all proposals from remote branches into the entries array.
 */
export async function loadRemoteProposals(
	git: GitOperations,
	config: LoaderConfig | null | undefined,
	_progressCallback: ((msg: string) => void) | undefined,
	_localProposals: Proposal[],
	entries: BranchProposalProposalEntry[],
): Promise<void> {
	if (config?.remoteOperations === false) return;

	const sinceDays = config?.activeBranchDays ?? 30;
	const proposalPrefix = config?.prefixes?.proposal ?? "proposal";
	const roadmapDir = "roadmap";

	const branches = await git.listRecentRemoteBranches(sinceDays);

	for (const branch of branches) {
		const files = await listFilesOnBranch(git, branch, roadmapDir);
		for (const filePath of files) {
			const entry = await loadProposalFromBranch(
				git,
				branch,
				filePath,
				proposalPrefix,
			);
			if (entry) {
				entries.push(entry);
			}
		}
	}
}

/**
 * Resolve a conflict when the same proposal exists on multiple branches.
 * Returns the entry with the most recent lastModified date.
 */
export function resolveProposalConflict(
	entries: BranchProposalProposalEntry[],
): BranchProposalProposalEntry | null {
	if (entries.length === 0) return null;
	// biome-ignore lint/style/noNonNullAssertion: length > 0 guaranteed
	let latest = entries[0]!;
	for (let i = 1; i < entries.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bound is entries.length
		const current = entries[i]!;
		if (current.lastModified > latest.lastModified) {
			latest = current;
		}
	}
	return latest;
}

/**
 * Get a human-readable loading message for proposal discovery.
 */
export function getProposalLoadingMessage(
	localCount: number,
	branchCount: number,
	remoteCount: number,
): string {
	const parts: string[] = [];
	if (localCount > 0) parts.push(`${localCount} local`);
	if (branchCount > 0) parts.push(`${branchCount} on branches`);
	if (remoteCount > 0) parts.push(`${remoteCount} remote`);
	return parts.length > 0
		? `Loaded ${parts.join(", ")} proposals`
		: "No proposals found";
}
