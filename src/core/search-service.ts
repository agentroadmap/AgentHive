/**
 * Search Service
 *
 * Lightweight in-memory full-text search over proposals.
 * Used by roadmap.ts for `search` command — indexes proposals from ContentStore.
 */

import type {
	Proposal,
	ProposalSearchResult,
	SearchFilters,
	SearchMatch,
	SearchOptions,
	SearchResult,
} from "../types/index.ts";

type ProposalProvider = { getProposals(): Proposal[] };

/**
 * SearchService — indexes proposals and provides ranked full-text search.
 */
export class SearchService {
	private provider: ProposalProvider;
	private initialized = false;

	constructor(provider: ProposalProvider) {
		this.provider = provider;
	}

	/**
	 * Ensure the search index is ready. Currently a no-op (lazy).
	 */
	async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
	}

	/**
	 * Search proposals by query string with optional filters.
	 *
	 * Returns results sorted by relevance score (highest first).
	 * When query is empty/omitted, returns all matching proposals (filters only).
	 */
	search(options: SearchOptions): SearchResult[] {
		const { query, limit, types, filters } = options;

		let proposals = this.provider.getProposals();

		// Apply type filter — only proposals for now
		if (types && !types.includes("proposal")) {
			return [];
		}

		// Apply field filters first (fast path)
		proposals = this.applyFilters(proposals, filters);

		// Apply text query
		if (query && query.trim().length > 0) {
			const scored = this.scoreProposals(proposals, query.trim());
			proposals = scored.map((s) => s.proposal);

			const results: ProposalSearchResult[] = scored.map(
				({ proposal, score, matches }) => ({
					type: "proposal" as const,
					score,
					proposal,
					matches,
				}),
			);

			return limit ? results.slice(0, limit) : results;
		}

		// No query — return all filtered proposals with null score
		const results: ProposalSearchResult[] = proposals.map((proposal) => ({
			type: "proposal" as const,
			score: null,
			proposal,
		}));

		return limit ? results.slice(0, limit) : results;
	}

	/**
	 * Apply field-level filters to a proposal list.
	 */
	private applyFilters(
		proposals: Proposal[],
		filters?: SearchFilters,
	): Proposal[] {
		if (!filters) return proposals;

		return proposals.filter((p) => {
			if (filters.status) {
				const statuses = Array.isArray(filters.status)
					? filters.status
					: [filters.status];
				if (!statuses.some((s) => p.status?.toLowerCase() === s.toLowerCase()))
					return false;
			}

			if (filters.priority) {
				const priorities = (
					Array.isArray(filters.priority)
						? filters.priority
						: [filters.priority]
				).map((p) => p.toLowerCase());
				if (!priorities.includes((p.priority ?? "").toLowerCase()))
					return false;
			}

			if (filters.assignee) {
				const assignees = (
					Array.isArray(filters.assignee)
						? filters.assignee
						: [filters.assignee]
				).map((a) => a.toLowerCase());
				const proposalAssignees = (p.assignee ?? []).map((a) =>
					a.toLowerCase(),
				);
				if (!assignees.some((a) => proposalAssignees.includes(a))) return false;
			}

			if (filters.labels) {
				const requiredLabels = Array.isArray(filters.labels)
					? filters.labels
					: [filters.labels];
				const proposalLabels = (p.labels ?? []).map((l) => l.toLowerCase());
				if (
					!requiredLabels.every((rl) =>
						proposalLabels.includes(rl.toLowerCase()),
					)
				)
					return false;
			}

			return true;
		});
	}

	/**
	 * Score proposals against a text query.
	 * Searches: title, id, description, labels, assignee.
	 */
	private scoreProposals(
		proposals: Proposal[],
		query: string,
	): Array<{ proposal: Proposal; score: number; matches: SearchMatch[] }> {
		const q = query.toLowerCase();
		const results: Array<{
			proposal: Proposal;
			score: number;
			matches: SearchMatch[];
		}> = [];

		for (const proposal of proposals) {
			const matches: SearchMatch[] = [];
			let score = 0;

			// Title match (highest weight)
			const titleIdx = proposal.title?.toLowerCase().indexOf(q) ?? -1;
			if (titleIdx >= 0) {
				score += 100;
				matches.push({
					key: "title",
					indices: [[titleIdx, titleIdx + q.length]],
					value: proposal.title,
				});
			}

			// ID exact match
			if (proposal.id?.toLowerCase().includes(q)) {
				score += 80;
				matches.push({
					key: "id",
					indices: [[0, proposal.id.length]],
					value: proposal.id,
				});
			}

			// Description match
			const descIdx = proposal.description?.toLowerCase().indexOf(q) ?? -1;
			if (descIdx >= 0) {
				score += 30;
				matches.push({
					key: "description",
					indices: [[descIdx, descIdx + q.length]],
					value: proposal.description,
				});
			}

			// Label match
			for (const label of proposal.labels ?? []) {
				if (label.toLowerCase().includes(q)) {
					score += 50;
					matches.push({
						key: "labels",
						indices: [[0, label.length]],
						value: label,
					});
				}
			}

			// Assignee match
			for (const assignee of proposal.assignee ?? []) {
				if (assignee.toLowerCase().includes(q)) {
					score += 40;
					matches.push({
						key: "assignee",
						indices: [[0, assignee.length]],
						value: assignee,
					});
				}
			}

			if (score > 0) {
				results.push({ proposal, score, matches });
			}
		}

		// Sort by score descending
		results.sort((a, b) => b.score - a.score);
		return results;
	}

	/**
	 * Dispose of resources.
	 */
	dispose(): void {
		if (!this.initialized) {
			return;
		}
		this.initialized = false;
	}
}
