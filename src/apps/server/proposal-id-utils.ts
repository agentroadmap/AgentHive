/**
 * proposal-id-utils.ts — loose proposal-ID matching helpers extracted from
 * `RoadmapServer` (P3796 monolith decomposition, Phase 2).
 *
 * These pure helpers normalise/parse proposal IDs (prefix handling + numeric
 * segment matching) and are shared by `index.ts` and the extracted route
 * modules (e.g. `routes/proposals.ts`). Keeping them in their own module avoids
 * a circular import between route modules and `index.ts`.
 */
import type { Proposal } from "../../types/index.ts";

// Regex pattern to match any prefix (letters followed by dash)
const PREFIX_PATTERN = /^[a-zA-Z]+-/i;
const DEFAULT_PREFIX = "proposal-";

/**
 * Strip any prefix from an ID (e.g., "proposal-123" -> "123", "JIRA-456" -> "456")
 */
export function stripPrefix(id: string): string {
	return id.replace(PREFIX_PATTERN, "");
}

/**
 * Ensure an ID has a prefix. If it already has one, return as-is.
 * Otherwise, add the default "proposal-" prefix.
 */
export function ensurePrefix(id: string): string {
	if (PREFIX_PATTERN.test(id)) {
		return id;
	}
	return `${DEFAULT_PREFIX}${id}`;
}

export function parseProposalIdSegments(value: string): number[] | null {
	const withoutPrefix = stripPrefix(value);
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(withoutPrefix)) {
		return null;
	}
	return withoutPrefix
		.split(".")
		.map((segment) => Number.parseInt(segment, 10));
}

export function findProposalByLooseId(
	proposals: Proposal[],
	inputId: string,
): Proposal | undefined {
	// First try exact match (case-insensitive)
	const lowerInputId = inputId.toLowerCase();
	const exact = proposals.find(
		(proposal) => proposal.id.toLowerCase() === lowerInputId,
	);
	if (exact) {
		return exact;
	}

	// Try matching by numeric segments only
	const inputSegments = parseProposalIdSegments(inputId);
	if (!inputSegments) {
		return undefined;
	}

	return proposals.find((proposal) => {
		const candidateSegments = parseProposalIdSegments(proposal.id);
		if (
			!candidateSegments ||
			candidateSegments.length !== inputSegments.length
		) {
			return false;
		}
		for (let index = 0; index < candidateSegments.length; index += 1) {
			if (candidateSegments[index] !== inputSegments[index]) {
				return false;
			}
		}
		return true;
	});
}
