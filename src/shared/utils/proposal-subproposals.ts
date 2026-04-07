import type { Proposal } from "../types/index.ts";
import { proposalIdsEqual } from "./proposal-path.ts";
import { sortByProposalId } from "./proposal-sorting.ts";

export function attachSubproposalSummaries(
	proposal: Proposal,
	proposals: Proposal[],
): Proposal {
	// Recursive depth calculation
	const calculateDepth = (s: Proposal): number => {
		if (!s.parentProposalId) return 0;
		const parent = proposals.find((candidate) =>
			proposalIdsEqual(s.parentProposalId ?? "", candidate.id),
		);
		if (!parent) {
			return 0;
		}
		return 1 + calculateDepth(parent);
	};

	const depth = calculateDepth(proposal);

	let parentTitle: string | undefined;
	if (proposal.parentProposalId) {
		const parent = proposals.find((candidate) =>
			proposalIdsEqual(proposal.parentProposalId ?? "", candidate.id),
		);
		if (parent) {
			parentTitle = parent.title;
		}
	}

	const summaries: Array<{ id: string; title: string }> = [];
	for (const candidate of proposals) {
		if (!candidate.parentProposalId) continue;
		if (!proposalIdsEqual(candidate.parentProposalId, proposal.id)) continue;
		summaries.push({ id: candidate.id, title: candidate.title });
	}

	if (summaries.length === 0) {
		if (parentTitle && parentTitle !== proposal.parentProposalTitle) {
			return {
				...proposal,
				parentProposalTitle: parentTitle,
			};
		}
		return proposal;
	}

	const sortedSummaries = sortByProposalId(summaries);
	return {
		...proposal,
		depth,
		...(parentTitle && parentTitle !== proposal.parentProposalTitle
			? { parentProposalTitle: parentTitle }
			: {}),
		subproposals: sortedSummaries.map((summary) => summary.id),
		subproposalSummaries: sortedSummaries,
	};
}
