/**
 * ID generation + proposal-snapshot helpers.
 *
 * Pure module-level helpers extracted from `roadmap.ts` (P3796 monolith
 * decomposition, Phase 1). These operate purely on in-memory branch/proposal
 * snapshot data with no `this`, no filesystem and no Postgres access, so they
 * live as free functions here.
 *
 * The `Core` ID-generation methods (`generateNextId`, `getExistingIdsForType`,
 * `getActiveAndCompletedProposalIds`) remain in `Core` because they orchestrate
 * filesystem / git / config access; they call these helpers.
 *
 * Must not import from `roadmap.ts` (no circular imports).
 */
import type { Proposal } from "../../types/index.ts";
import type { BranchProposalProposalEntry } from "../storage/proposal-loader.ts";

/**
 * Build a map of proposal id → the latest authoritative snapshot entry across
 * branches and local proposal/archived sets. Local terminal entries (archived
 * or completed on the `local` branch) win over everything else.
 */
export function buildLatestProposalMap(
	proposalEntries: BranchProposalProposalEntry[] = [],
	localProposals: Array<
		Proposal & { lastModified?: Date; updatedDate?: string }
	> = [],
	localArchivedProposals: Array<
		Proposal & { lastModified?: Date; updatedDate?: string }
	> = [],
): Map<string, BranchProposalProposalEntry> {
	const latest = new Map<string, BranchProposalProposalEntry>();
	const isAuthoritativeLocalTerminal = (
		entry?: BranchProposalProposalEntry,
	): boolean =>
		Boolean(
			entry &&
				entry.branch === "local" &&
				(entry.type === "archived" || entry.type === "completed"),
		);
	const update = (entry: BranchProposalProposalEntry) => {
		const existing = latest.get(entry.id);
		if (isAuthoritativeLocalTerminal(existing)) {
			return;
		}
		if (
			isAuthoritativeLocalTerminal(entry) ||
			!existing ||
			entry.lastModified > existing.lastModified
		) {
			latest.set(entry.id, entry);
		}
	};

	for (const entry of proposalEntries) {
		update(entry);
	}

	for (const proposal of localProposals) {
		if (!proposal.id) continue;
		const lastModified =
			proposal.lastModified ??
			(proposal.updatedDate ? new Date(proposal.updatedDate) : new Date(0));

		update({
			id: proposal.id,
			type: "proposal",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	for (const proposal of localArchivedProposals) {
		if (!proposal.id) continue;
		const lastModified =
			proposal.lastModified ??
			(proposal.updatedDate ? new Date(proposal.updatedDate) : new Date(0));

		update({
			id: proposal.id,
			type: "archived",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	return latest;
}

/** Keep only proposals whose latest snapshot is a live "proposal" (drop archived/completed). */
export function filterProposalsByProposalSnapshots(
	proposals: Proposal[],
	latestProposal: Map<string, BranchProposalProposalEntry>,
): Proposal[] {
	return proposals.filter((proposal) => {
		const latest = latestProposal.get(proposal.id);
		if (!latest) return true;
		return latest.type === "proposal";
	});
}

/**
 * Extract IDs from proposal map where latest proposal is "proposal" or "completed" (not "archived" or "draft")
 * Used for ID generation to determine which IDs are in use.
 */
export function getActiveAndCompletedIdsFromProposalMap(
	latestProposal: Map<string, BranchProposalProposalEntry>,
): string[] {
	const ids: string[] = [];
	for (const [id, entry] of latestProposal) {
		if (entry.type === "proposal" || entry.type === "completed") {
			ids.push(id);
		}
	}
	return ids;
}
