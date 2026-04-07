import Fuse, { type FuseResult, type FuseResultMatch } from "fuse.js";
import type {
	Decision,
	Document,
	Proposal,
	SearchFilters,
	SearchMatch,
	SearchOptions,
	SearchPriorityFilter,
	SearchResult,
	SearchResultType,
} from "../../types/index.ts";
import { isCompleteStatus, isTerminalStatus } from "../proposal/directives.ts";
import type {
	ContentStore,
	ContentStoreEvent,
} from "../storage/content-store.ts";

interface BaseSearchEntity {
	readonly id: string;
	readonly type: SearchResultType;
	readonly title: string;
	readonly bodyText: string;
}

interface ProposalSearchEntity extends BaseSearchEntity {
	readonly type: "proposal";
	readonly proposal: Proposal;
	readonly statusLower: string;
	readonly priorityLower?: SearchPriorityFilter;
	readonly labelsLower: string[];
	readonly idVariants: string[];
	readonly dependencyIds: string[];
	readonly rationaleLower?: string;
}

interface DocumentSearchEntity extends BaseSearchEntity {
	readonly type: "document";
	readonly document: Document;
}

interface DecisionSearchEntity extends BaseSearchEntity {
	readonly type: "decision";
	readonly decision: Decision;
}

type SearchEntity =
	| ProposalSearchEntity
	| DocumentSearchEntity
	| DecisionSearchEntity;

type NormalizedFilters = {
	statuses?: string[];
	priorities?: SearchPriorityFilter[];
	labels?: string[];
	ready?: boolean;
	rationale?: string[];
};

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

function parseProposalIdSegments(value: string): number[] | null {
	const withoutPrefix = stripPrefix(value.toLowerCase());
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(withoutPrefix)) {
		return null;
	}
	return withoutPrefix
		.split(".")
		.map((segment) => Number.parseInt(segment, 10));
}

function createProposalIdVariants(id: string): string[] {
	const lowerId = id.toLowerCase();
	const segments = parseProposalIdSegments(id);
	const prefix = extractPrefix(id) ?? "proposal-"; // Default to proposal- if no prefix

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

	// Also add individual numeric segments for short-query matching (e.g., "7" matching "STATE-0007")
	for (const segment of segments) {
		variants.add(String(segment));
	}

	return Array.from(variants);
}

export class SearchService {
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private unsubscribe?: () => void;
	private fuse: Fuse<SearchEntity> | null = null;
	private proposals: ProposalSearchEntity[] = [];
	private documents: DocumentSearchEntity[] = [];
	private decisions: DecisionSearchEntity[] = [];
	private collection: SearchEntity[] = [];
	private version = 0;
	private readonly store: ContentStore;

	constructor(store: ContentStore) {
		this.store = store;
	}

	async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}

		if (!this.initializing) {
			this.initializing = this.initialize().catch((error) => {
				this.initializing = null;
				throw error;
			});
		}

		await this.initializing;
	}

	dispose(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		this.fuse = null;
		this.collection = [];
		this.proposals = [];
		this.documents = [];
		this.decisions = [];
		this.initialized = false;
		this.initializing = null;
	}

	search(options: SearchOptions = {}): SearchResult[] {
		if (!this.initialized) {
			throw new Error(
				"SearchService not initialized. Call ensureInitialized() first.",
			);
		}

		const { query = "", limit, types, filters } = options;

		const trimmedQuery = query.trim();
		const allowedTypes = new Set<SearchResultType>(
			types && types.length > 0 ? types : ["proposal", "document", "decision"],
		);
		const normalizedFilters = this.normalizeFilters(filters);

		if (trimmedQuery === "") {
			return this.collectWithoutQuery(allowedTypes, normalizedFilters, limit);
		}

		// SQLite removed — use Fuse.js for full-text search
		const fuse = this.fuse;
		if (!fuse) {
			return [];
		}

		const doneIds = normalizedFilters.ready
			? new Set(
					this.proposals
						.filter((t) => isCompleteStatus(t.proposal.status))
						.map((t) => t.id),
				)
			: undefined;

		const fuseResults = fuse.search(trimmedQuery);
		const results: SearchResult[] = [];

		for (const result of fuseResults) {
			const entity = result.item;
			if (!allowedTypes.has(entity.type)) {
				continue;
			}

			if (
				entity.type === "proposal" &&
				!this.matchesProposalFilters(entity, normalizedFilters, doneIds)
			) {
				continue;
			}

			results.push(this.mapEntityToResult(entity, result));
			if (limit && results.length >= limit) {
				break;
			}
		}

		return results;
	}

	private async initialize(): Promise<void> {
		const snapshot = await this.store.ensureInitialized();
		this.applySnapshot(
			snapshot.proposals,
			snapshot.documents,
			snapshot.decisions,
		);

		if (!this.unsubscribe) {
			this.unsubscribe = this.store.subscribe((event) => {
				this.handleStoreEvent(event);
			});
		}

		this.initialized = true;
		this.initializing = null;
	}

	private handleStoreEvent(event: ContentStoreEvent): void {
		if (event.version <= this.version) {
			return;
		}
		this.version = event.version;
		this.applySnapshot(
			event.snapshot.proposals,
			event.snapshot.documents,
			event.snapshot.decisions,
		);
	}

	private applySnapshot(
		proposals: Proposal[],
		documents: Document[],
		decisions: Decision[],
	): void {
		this.proposals = proposals.map((proposal) => ({
			id: proposal.id,
			type: "proposal",
			title: proposal.title,
			bodyText: buildProposalBodyText(proposal),
			proposal,
			statusLower: proposal.status.toLowerCase(),
			priorityLower: proposal.priority
				? (proposal.priority.toLowerCase() as SearchPriorityFilter)
				: undefined,
			labelsLower: (proposal.labels || []).map((label) => label.toLowerCase()),
			idVariants: createProposalIdVariants(proposal.id),
			dependencyIds: (proposal.dependencies ?? []).flatMap((dependency) =>
				createProposalIdVariants(dependency),
			),
			rationaleLower: proposal.rationale?.toLowerCase(),
		}));

		this.documents = documents.map((document) => ({
			id: document.id,
			type: "document",
			title: document.title,
			bodyText: document.rawContent ?? "",
			document,
		}));

		this.decisions = decisions.map((decision) => ({
			id: decision.id,
			type: "decision",
			title: decision.title,
			bodyText: decision.rawContent ?? "",
			decision,
		}));

		this.collection = [...this.proposals, ...this.documents, ...this.decisions];
		this.rebuildFuse();
	}

	private rebuildFuse(): void {
		if (this.collection.length === 0) {
			this.fuse = null;
			return;
		}

		this.fuse = new Fuse(this.collection, {
			includeScore: true,
			includeMatches: true,
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
	}

	private collectWithoutQuery(
		allowedTypes: Set<SearchResultType>,
		filters: NormalizedFilters,
		limit?: number,
	): SearchResult[] {
		const results: SearchResult[] = [];

		if (allowedTypes.has("proposal")) {
			const proposals = this.applyProposalFilters(this.proposals, filters);
			for (const entity of proposals) {
				results.push(this.mapEntityToResult(entity));
				if (limit && results.length >= limit) {
					return results;
				}
			}
		}

		if (allowedTypes.has("document")) {
			for (const entity of this.documents) {
				results.push(this.mapEntityToResult(entity));
				if (limit && results.length >= limit) {
					return results;
				}
			}
		}

		if (allowedTypes.has("decision")) {
			for (const entity of this.decisions) {
				results.push(this.mapEntityToResult(entity));
				if (limit && results.length >= limit) {
					return results;
				}
			}
		}

		return results;
	}

	private applyProposalFilters(
		proposals: ProposalSearchEntity[],
		filters: NormalizedFilters,
	): ProposalSearchEntity[] {
		let filtered = proposals;
		if (filters.statuses && filters.statuses.length > 0) {
			const allowedStatuses = new Set(filters.statuses);
			filtered = filtered.filter((proposal) =>
				allowedStatuses.has(proposal.statusLower),
			);
		}
		if (filters.priorities && filters.priorities.length > 0) {
			const allowedPriorities = new Set(filters.priorities);
			filtered = filtered.filter((proposal) => {
				if (!proposal.priorityLower) {
					return false;
				}
				return allowedPriorities.has(proposal.priorityLower);
			});
		}
		if (filters.labels && filters.labels.length > 0) {
			const requiredLabels = new Set(filters.labels);
			filtered = filtered.filter((proposal) => {
				if (!proposal.labelsLower || proposal.labelsLower.length === 0) {
					return false;
				}
				return proposal.labelsLower.some((label) => requiredLabels.has(label));
			});
		}
		if (filters.rationale && filters.rationale.length > 0) {
			const allowedRationales = new Set(filters.rationale);
			filtered = filtered.filter((proposal) => {
				if (!proposal.rationaleLower) return false;
				return allowedRationales.has(proposal.rationaleLower);
			});
		}
		if (filters.ready) {
			const doneIds = new Set(
				proposals
					.filter((t) => isCompleteStatus(t.proposal.status))
					.map((t) => t.id),
			);

			filtered = filtered.filter((entity) => {
				const proposal = entity.proposal;
				if (isTerminalStatus(proposal.status)) return false;
				if (proposal.assignee && proposal.assignee.length > 0) return false;
				const deps = proposal.dependencies || [];
				if (deps.length > 0) {
					const hasBlockingDependency = deps.some(
						(depId) => !doneIds.has(depId),
					);
					if (hasBlockingDependency) return false;
				}
				return true;
			});
		}
		return filtered;
	}

	private matchesProposalFilters(
		proposal: ProposalSearchEntity,
		filters: NormalizedFilters,
		doneIds?: Set<string>,
	): boolean {
		if (filters.statuses && filters.statuses.length > 0) {
			if (!filters.statuses.includes(proposal.statusLower)) {
				return false;
			}
		}

		if (filters.priorities && filters.priorities.length > 0) {
			if (
				!proposal.priorityLower ||
				!filters.priorities.includes(proposal.priorityLower)
			) {
				return false;
			}
		}

		if (filters.labels && filters.labels.length > 0) {
			if (!proposal.labelsLower || proposal.labelsLower.length === 0) {
				return false;
			}
			const labelSet = new Set(proposal.labelsLower);
			const anyMatch = filters.labels.some((label) => labelSet.has(label));
			if (!anyMatch) {
				return false;
			}
		}

		if (filters.rationale && filters.rationale.length > 0) {
			if (
				!proposal.rationaleLower ||
				!filters.rationale.includes(proposal.rationaleLower)
			) {
				return false;
			}
		}

		if (filters.ready) {
			// 1. Must not be terminal
			if (isTerminalStatus(proposal.proposal.status)) return false;

			// 2. Must be unassigned
			if (proposal.proposal.assignee && proposal.proposal.assignee.length > 0)
				return false;

			// 3. Dependencies must be done
			const deps = proposal.proposal.dependencies || [];
			if (deps.length > 0) {
				if (!doneIds) return false; // Safety check
				const hasBlockingDependency = deps.some((depId) => !doneIds.has(depId));
				if (hasBlockingDependency) return false;
			}
		}

		return true;
	}

	private normalizeFilters(filters?: SearchFilters): NormalizedFilters {
		if (!filters) {
			return {};
		}

		const statuses = this.normalizeStringArray(filters.status);
		const priorities = this.normalizePriorityArray(filters.priority);
		const labels = this.normalizeLabelsArray(filters.labels);
		const rationale = this.normalizeStringArray((filters as any).rationale);
		// Note: SearchFilters type already includes 'ready' from our earlier update to src/types/index.ts
		const ready = (filters as any).ready === true;

		return {
			statuses,
			priorities,
			labels,
			ready,
			rationale,
		};
	}

	private normalizeStringArray(
		value?: string | string[],
	): string[] | undefined {
		if (!value) {
			return undefined;
		}

		const values = Array.isArray(value) ? value : [value];
		const normalized = values
			.map((item) => item.trim().toLowerCase())
			.filter((item) => item.length > 0);

		return normalized.length > 0 ? normalized : undefined;
	}

	private normalizeLabelsArray(
		value?: string | string[],
	): string[] | undefined {
		if (!value) {
			return undefined;
		}

		const values = Array.isArray(value) ? value : [value];
		const normalized = values
			.map((item) => item.trim().toLowerCase())
			.filter((item) => item.length > 0);

		return normalized.length > 0 ? normalized : undefined;
	}

	private normalizePriorityArray(
		value?: SearchPriorityFilter | SearchPriorityFilter[],
	): SearchPriorityFilter[] | undefined {
		if (!value) {
			return undefined;
		}

		const values = Array.isArray(value) ? value : [value];
		const normalized = values
			.map((item) => item.trim().toLowerCase())
			.filter((item): item is SearchPriorityFilter => {
				return item === "high" || item === "medium" || item === "low";
			});

		return normalized.length > 0 ? normalized : undefined;
	}

	private mapEntityToResult(
		entity: SearchEntity,
		result?: FuseResult<SearchEntity>,
	): SearchResult {
		const score = result?.score ?? null;
		const matches = this.mapMatches(result?.matches);

		if (entity.type === "proposal") {
			return {
				type: "proposal",
				score,
				proposal: entity.proposal,
				matches,
			};
		}

		if (entity.type === "document") {
			return {
				type: "document",
				score,
				document: entity.document,
				matches,
			};
		}

		return {
			type: "decision",
			score,
			decision: entity.decision,
			matches,
		};
	}

	private mapMatches(
		matches?: readonly FuseResultMatch[],
	): SearchMatch[] | undefined {
		if (!matches || matches.length === 0) {
			return undefined;
		}

		return matches.map((match) => ({
			key: match.key,
			indices: match.indices.map(
				([start, end]) => [start, end] as [number, number],
			),
			value: match.value,
		}));
	}
}
function buildProposalBodyText(proposal: Proposal): string {
	const parts: string[] = [];

	if (proposal.description) {
		parts.push(proposal.description);
	}

	if (
		Array.isArray(proposal.acceptanceCriteriaItems) &&
		proposal.acceptanceCriteriaItems.length > 0
	) {
		const lines = [...proposal.acceptanceCriteriaItems]
			.sort((a, b) => a.index - b.index)
			.map(
				(criterion) => `- [${criterion.checked ? "x" : " "}] ${criterion.text}`,
			);
		parts.push(lines.join("\n"));
	}

	if (proposal.implementationPlan) {
		parts.push(proposal.implementationPlan);
	}

	if (proposal.implementationNotes) {
		parts.push(proposal.implementationNotes);
	}

	return parts.join("\n\n");
}
