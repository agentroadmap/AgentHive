/**
 * In-memory proposal search using Fuse.js
 * Used when proposals are already loaded to avoid re-fetching via ContentStore
 */

import Fuse from "fuse.js";
import type { Proposal } from "../types/index.ts";
import { isCompleteStatus, isTerminalStatus } from "./status.ts";

export interface ProposalSearchOptions {
	query?: string;
	status?: string;
	priority?: "high" | "medium" | "low";
	labels?: string[];
	ready?: boolean;
}

export interface SharedProposalFilterOptions {
	query?: string;
	priority?: "high" | "medium" | "low";
	labels?: string[];
	directive?: string;
	resolveDirectiveLabel?: (directive: string) => string;
	ready?: boolean;
}

export interface ProposalFilterOptions extends SharedProposalFilterOptions {
	status?: string;
}

export interface ProposalSearchIndex {
	search(options: ProposalSearchOptions): Proposal[];
}

// Regex pattern to match any prefix (letters followed by dash)
const PREFIX_PATTERN = /^[a-zA-Z]+-/i;

/**
 * Extract prefix from an ID if present (e.g., "proposal-" from "proposal-123")
 */
function extractPrefix(id: string): string | null {
	const match = id.match(PREFIX_PATTERN);
	return match ? match[0] : null;
}

/**
 * Strip any prefix from an ID (e.g., "proposal-123" -> "123", "JIRA-456" -> "456")
 */
function stripPrefix(id: string): string {
	return id.replace(PREFIX_PATTERN, "");
}

function createProposalIdVariants(id: string): string[] {
	const segments = parseProposalIdSegments(id);
	const prefix = extractPrefix(id) ?? "proposal-"; // Default to proposal- if no prefix
	const lowerId = id.toLowerCase();

	if (!segments) {
		// Non-numeric ID - just return the ID and its lowercase variant
		return id === lowerId ? [id] : [id, lowerId];
	}

	const canonicalSuffix = segments.join(".");
	const variants = new Set<string>();

	// Add original ID and lowercase variant
	variants.add(id);
	variants.add(lowerId);

	// Add with extracted/default prefix
	variants.add(`${prefix}${canonicalSuffix}`);
	variants.add(`${prefix.toLowerCase()}${canonicalSuffix}`);

	// Add just the numeric part
	variants.add(canonicalSuffix);

	return Array.from(variants);
}

function parseProposalIdSegments(value: string): number[] | null {
	const withoutPrefix = stripPrefix(value);
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(withoutPrefix)) {
		return null;
	}
	return withoutPrefix
		.split(".")
		.map((segment) => Number.parseInt(segment, 10));
}

interface SearchableProposal {
	proposal: Proposal;
	title: string;
	bodyText: string;
	id: string;
	idVariants: string[];
	dependencyIds: string[];
	statusLower: string;
	priorityLower?: string;
	labelsLower: string[];
}

function buildSearchableProposal(proposal: Proposal): SearchableProposal {
	const bodyParts: string[] = [];
	if (proposal.description) bodyParts.push(proposal.description);
	if (
		Array.isArray(proposal.acceptanceCriteriaItems) &&
		proposal.acceptanceCriteriaItems.length > 0
	) {
		const lines = [...proposal.acceptanceCriteriaItems]
			.sort((a, b) => a.index - b.index)
			.map(
				(criterion) => `- [${criterion.checked ? "x" : " "}] ${criterion.text}`,
			);
		bodyParts.push(lines.join("\n"));
	}
	if (proposal.implementationPlan) bodyParts.push(proposal.implementationPlan);
	if (proposal.implementationNotes)
		bodyParts.push(proposal.implementationNotes);
	if (proposal.labels?.length) bodyParts.push(proposal.labels.join(" "));
	if (proposal.assignee?.length) bodyParts.push(proposal.assignee.join(" "));

	return {
		proposal,
		title: proposal.title,
		bodyText: bodyParts.join(" "),
		id: proposal.id,
		idVariants: createProposalIdVariants(proposal.id),
		dependencyIds: (proposal.dependencies ?? []).flatMap((dependency) =>
			createProposalIdVariants(dependency),
		),
		statusLower: (proposal.status || "").toLowerCase(),
		priorityLower: proposal.priority?.toLowerCase(),
		labelsLower: (proposal.labels || []).map((label) => label.toLowerCase()),
	};
}

/**
 * Create an in-memory search index for proposals
 */
export function createProposalSearchIndex(
	proposals: Proposal[],
): ProposalSearchIndex {
	const searchableProposals = proposals.map(buildSearchableProposal);

	const fuse = new Fuse(searchableProposals, {
		includeScore: true,
		threshold: 0.35,
		ignoreLocation: true,
		minMatchCharLength: 2,
		keys: [
			{ name: "title", weight: 0.35 },
			{ name: "bodyText", weight: 0.3 },
			{ name: "id", weight: 0.2 },
			{ name: "idVariants", weight: 0.1 },
			{ name: "dependencyIds", weight: 0.05 },
		],
	});

	return {
		search(options: ProposalSearchOptions): Proposal[] {
			let results: SearchableProposal[];

			// If we have a query, use Fuse for fuzzy search
			if (options.query?.trim()) {
				const fuseResults = fuse.search(options.query.trim());
				results = fuseResults.map((r) => r.item);
			} else {
				// No query - start with all proposals
				results = [...searchableProposals];
			}

			// Apply status filter
			if (options.status) {
				const statusLower = options.status.toLowerCase();
				results = results.filter((t) => t.statusLower === statusLower);
			}

			// Apply priority filter
			if (options.priority) {
				const priorityLower = options.priority.toLowerCase();
				results = results.filter((t) => t.priorityLower === priorityLower);
			}

			// Apply label filters (proposal must include any selected label)
			if (options.labels && options.labels.length > 0) {
				const required = options.labels.map((label) => label.toLowerCase());
				results = results.filter((t) => {
					if (!t.labelsLower || t.labelsLower.length === 0) {
						return false;
					}
					const labelSet = new Set(t.labelsLower);
					return required.some((label) => labelSet.has(label));
				});
			}

			// Apply ready filter
			if (options.ready) {
				const doneIds = new Set(
					searchableProposals
						.filter((t) => isCompleteStatus(t.proposal.status))
						.map((t) => t.id),
				);
				results = results.filter((t) => {
					const proposal = t.proposal;
					if (isTerminalStatus(proposal.status)) return false;
					if (proposal.assignee && proposal.assignee.length > 0) return false;
					const deps = proposal.dependencies || [];
					if (deps.length > 0) {
						return deps.every((depId) => doneIds.has(depId));
					}
					return true;
				});
			}

			return results.map((r) => r.proposal);
		},
	};
}

function applyDirectiveFilter(
	proposals: Proposal[],
	directive: string,
	resolveDirectiveLabel?: (directive: string) => string,
): Proposal[] {
	const normalizedDirective = directive.trim().toLowerCase();
	if (!normalizedDirective) {
		return proposals;
	}

	return proposals.filter((proposal) => {
		if (!proposal.directive) {
			return false;
		}
		const value = resolveDirectiveLabel
			? resolveDirectiveLabel(proposal.directive)
			: proposal.directive;
		return value.trim().toLowerCase() === normalizedDirective;
	});
}

export function applyProposalFilters(
	proposals: Proposal[],
	options: ProposalFilterOptions,
	index?: ProposalSearchIndex,
): Proposal[] {
	const query = options.query?.trim() ?? "";
	const hasBaseFilters = Boolean(
		query ||
			options.status ||
			options.priority ||
			(options.labels && options.labels.length > 0) ||
			options.ready,
	);

	let results = hasBaseFilters
		? (index ?? createProposalSearchIndex(proposals)).search({
				query,
				status: options.status,
				priority: options.priority,
				labels: options.labels,
				ready: options.ready,
			})
		: [...proposals];

	if (options.directive) {
		results = applyDirectiveFilter(
			results,
			options.directive,
			options.resolveDirectiveLabel,
		);
	}

	return results;
}

export function applySharedProposalFilters(
	proposals: Proposal[],
	options: SharedProposalFilterOptions,
	index?: ProposalSearchIndex,
): Proposal[] {
	return applyProposalFilters(
		proposals,
		{
			query: options.query,
			priority: options.priority,
			labels: options.labels,
			directive: options.directive,
			resolveDirectiveLabel: options.resolveDirectiveLabel,
			ready: options.ready,
		},
		index,
	);
}
