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

/**
 * Canonical key for proposal-id matching, consistent with proposalIdsEqual:
 * proposals match on their dotted-numeric body (leading zeros normalised),
 * independent of any alpha prefix (P / STATE- / STEP- …). Ids without a
 * numeric body fall back to the lower-cased raw string.
 */
function canonicalProposalKey(id: string | number): string {
	const raw = String(id).trim();
	const match = raw.match(/(\d+(?:\.\d+)*)\s*$/);
	if (match) {
		return match[1]
			.split(".")
			.map((segment) => String(Number.parseInt(segment, 10)))
			.join(".");
	}
	return raw.toLowerCase();
}

/**
 * O(n) batch equivalent of mapping attachSubproposalSummaries over a list.
 *
 * The per-item function scans the full reference list three times (depth
 * recursion, parent lookup, child collection), each via proposalIdsEqual —
 * O(n²) overall, which on the ~700-row board cost ~1.3s on every 5s refresh.
 * This pre-indexes parent/children once and memoises depth so the whole pass
 * is linear, while producing structurally identical Proposal objects.
 *
 * @param proposals       the proposals to enrich (output order preserved)
 * @param referenceList   the universe used for parent/child resolution
 *                        (defaults to `proposals`); mirrors the per-item
 *                        function's `proposals` argument.
 */
export function attachSubproposalSummariesBatch(
	proposals: Proposal[],
	referenceList?: Proposal[],
): Proposal[] {
	const reference =
		referenceList && referenceList.length > 0 ? referenceList : proposals;

	const byKey = new Map<string, Proposal>();
	const childrenByParentKey = new Map<
		string,
		Array<{ id: string; title: string }>
	>();
	for (const candidate of reference) {
		byKey.set(canonicalProposalKey(candidate.id), candidate);
		if (!candidate.parentProposalId) continue;
		const parentKey = canonicalProposalKey(candidate.parentProposalId);
		const bucket = childrenByParentKey.get(parentKey);
		if (bucket) {
			bucket.push({ id: candidate.id, title: candidate.title });
		} else {
			childrenByParentKey.set(parentKey, [
				{ id: candidate.id, title: candidate.title },
			]);
		}
	}

	const depthCache = new Map<string, number>();
	const depthOf = (proposal: Proposal, seen: Set<string>): number => {
		if (!proposal.parentProposalId) return 0;
		const selfKey = canonicalProposalKey(proposal.id);
		const cached = depthCache.get(selfKey);
		if (cached !== undefined) return cached;
		if (seen.has(selfKey)) return 0; // cycle guard
		seen.add(selfKey);
		const parent = byKey.get(canonicalProposalKey(proposal.parentProposalId));
		const depth = parent ? 1 + depthOf(parent, seen) : 0;
		depthCache.set(selfKey, depth);
		return depth;
	};

	return proposals.map((proposal) => {
		const depth = depthOf(proposal, new Set());

		let parentTitle: string | undefined;
		if (proposal.parentProposalId) {
			const parent = byKey.get(canonicalProposalKey(proposal.parentProposalId));
			if (parent) parentTitle = parent.title;
		}

		const summaries =
			childrenByParentKey.get(canonicalProposalKey(proposal.id)) ?? [];

		if (summaries.length === 0) {
			if (parentTitle && parentTitle !== proposal.parentProposalTitle) {
				return { ...proposal, parentProposalTitle: parentTitle };
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
	});
}
